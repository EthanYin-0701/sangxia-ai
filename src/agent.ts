import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { stat } from "node:fs/promises";
import {
  type Agent,
  type AgentSideConnection,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  PROTOCOL_VERSION,
  type PromptRequest,
  type PromptResponse,
  RequestError,
} from "@zed-industries/agent-client-protocol";
import { promptToText } from "./acp/content.js";
import type { Config } from "./config.js";
import { runTurn } from "./harness/loop.js";
import { type Tool, ToolRegistry } from "./harness/tool.js";
import { createProvider } from "./llm/factory.js";
import type { LLMProvider } from "./llm/types.js";
import { logger } from "./logger.js";
import { connectMcpServer } from "./mcp/client.js";
import { loadProjectMemory, missingProjectMemory } from "./project-memory.js";
import { loadSession as loadPersistedSession, saveSession } from "./persistence.js";
import { type ClientCapabilities, Session } from "./session.js";
import { discoverSkills, skillCatalogPrompt, useSkillTool } from "./skills/index.js";
import { buildTools } from "./tools/index.js";

/**
 * The ACP agent surface. It owns sessions and delegates the actual work of a
 * prompt turn to the harness ({@link runTurn}).
 */
export class ZhenTeAgent implements Agent {
  readonly #conn: AgentSideConnection;
  readonly #config: Config;
  readonly #provider: LLMProvider;
  readonly #builtinTools: Tool[];
  readonly #sessions = new Map<string, Session>();
  #clientCaps: ClientCapabilities = { readTextFile: false, writeTextFile: false, terminal: false };

  constructor(conn: AgentSideConnection, config: Config) {
    this.#conn = conn;
    this.#config = config;
    this.#provider = createProvider(config.provider);
    this.#builtinTools = buildTools();
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    const fs = params.clientCapabilities?.fs;
    this.#clientCaps = {
      readTextFile: Boolean(fs?.readTextFile),
      writeTextFile: Boolean(fs?.writeTextFile),
      terminal: Boolean(params.clientCapabilities?.terminal),
    };
    logger.info("initialize: client caps =", this.#clientCaps);
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        // stdio MCP is mandatory (no flag); advertise network transports too.
        mcpCapabilities: { http: true, sse: true },
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const id = randomUUID();
    const session = new Session(id, params.cwd, params.mcpServers ?? [], this.#clientCaps);
    await this.prepareSession(session);
    session.messages.push({ role: "system", content: await this.systemPrompt(params.cwd, session.skills) });
    this.#sessions.set(id, session);
    await this.persist(session);
    logger.info(`newSession ${id} cwd=${params.cwd} mcpServers=${session.mcpServers.length}`);
    return { sessionId: id };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const saved = await loadPersistedSession(params.sessionId);
    if (!saved) throw RequestError.invalidParams({ sessionId: `找不到已保存会话: ${params.sessionId}` });
    const session = new Session(params.sessionId, params.cwd || saved.cwd, params.mcpServers ?? [], this.#clientCaps);
    await this.prepareSession(session);
    session.messages = saved.messages;
    this.#sessions.set(session.id, session);
    logger.info(`loadSession ${session.id} cwd=${session.cwd} messages=${session.messages.length}`);
    return {};
  }

  private async prepareSession(session: Session): Promise<void> {

    // Discover skills for this cwd. Only their name+description catalog goes into
    // the prompt; bodies load on demand via the `use_skill` tool.
    if (this.#config.skills.enabled) {
      try {
        session.skills = await discoverSkills(session.cwd, this.#config.skills.dirs);
      } catch (e) {
        logger.warn(`技能发现失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Connect the MCP servers the client passed, isolating failures per-server so
    // one bad server can't sink the whole session.
    const mcpTools: Tool[] = [];
    if (this.#config.mcp.enabled) {
      for (const server of session.mcpServers) {
        try {
          const conn = await connectMcpServer(server, this.#config.mcp.connectTimeoutMs);
          session.mcpConnections.push(conn);
          mcpTools.push(...conn.tools);
        } catch (e) {
          logger.warn(`MCP '${server.name}' 连接失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    // Assemble this session's tool set: built-ins + use_skill (only if skills
    // exist) + the connected MCP tools.
    session.tools = new ToolRegistry([
      ...this.#builtinTools,
      ...(session.skills.length > 0 ? [useSkillTool] : []),
      ...mcpTools,
    ]);

  }

  private async systemPrompt(cwd: string, skills: Session["skills"], memoryCwd = cwd): Promise<string> {
    const memory = await loadProjectMemory(memoryCwd).catch((e) => {
      logger.warn(`项目记忆读取失败: ${e instanceof Error ? e.message : String(e)}`);
      return "";
    });
    return (this.#config.agent.systemPrompt ?? defaultSystemPrompt(cwd)) + skillCatalogPrompt(skills) + memory;
  }

  private async persist(session: Session): Promise<void> {
    try {
      await saveSession({ version: 1, sessionId: session.id, cwd: session.cwd, messages: session.messages, updatedAt: new Date().toISOString() });
    } catch (e) {
      logger.warn(`session ${session.id} 持久化失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.#sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams({ sessionId: `未知会话: ${params.sessionId}` });
    }

    const text = promptToText(params.prompt);
    await this.maybeInitializeProject(session, text);
    session.messages.push({ role: "user", content: text });
    await this.persist(session);

    const abort = new AbortController();
    session.abort = abort;
    try {
      const stopReason = await runTurn({
        conn: this.#conn,
        session,
        provider: this.#provider,
        tools: session.tools,
        config: this.#config.agent,
        signal: abort.signal,
      });
      await this.persist(session);
      logger.info(`prompt ${params.sessionId} → ${stopReason}`);
      return { stopReason };
    } finally {
      session.abort = null;
    }
  }

  private async maybeInitializeProject(session: Session, prompt: string): Promise<void> {
    if (session.initializationChecked) return;
    session.initializationChecked = true;
    const mentionedDirectory = await findMentionedDirectory(prompt, session.cwd);
    const initializationDirectory = mentionedDirectory ?? session.cwd;
    let missing: string[];
    try {
      missing = await missingProjectMemory(initializationDirectory);
    } catch (e) {
      logger.warn(`项目记忆检查失败: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (missing.length === 0) return;

    const parentCwd = dirname(session.cwd);
    const hasMentionedDirectory = mentionedDirectory !== null;
    const initializationPath = relative(session.cwd, initializationDirectory) || ".";
    const decision = await this.#conn.requestPermission({
      sessionId: session.id,
      toolCall: {
        toolCallId: `project_init_${Date.now()}`,
        title: `初始化项目记忆（缺少 ${missing.join("、")}）${hasMentionedDirectory ? `；prompt 提到了目录 ${initializationDirectory}，是否在该目录下初始化？` : "；是否需要读取工作目录的上层目录？"}`,
        kind: "edit",
        rawInput: { cwd: session.cwd, initializationDirectory, parentCwd, files: missing },
      },
      options: hasMentionedDirectory
        ? [
            { optionId: "initialize", name: "当前目录初始化", kind: "allow_once" },
            { optionId: "initialize_with_parent", name: "当前目录初始化并读取上层目录", kind: "allow_once" },
            { optionId: "initialize_in_mentioned", name: `在 ${initializationPath} 下初始化`, kind: "allow_once" },
            { optionId: "initialize_in_mentioned_with_parent", name: `在 ${initializationPath} 下初始化并读取上层目录`, kind: "allow_once" },
            { optionId: "skip", name: "跳过", kind: "reject_once" },
          ]
        : [
            { optionId: "initialize", name: "初始化（仅当前目录）", kind: "allow_once" },
            { optionId: "initialize_with_parent", name: "初始化并读取上层目录", kind: "allow_once" },
            { optionId: "skip", name: "跳过", kind: "reject_once" },
          ],
    });
    const validOptions = ["initialize", "initialize_with_parent", "initialize_in_mentioned", "initialize_in_mentioned_with_parent"];
    if (decision.outcome.outcome === "cancelled" || !validOptions.includes(decision.outcome.optionId)) {
      logger.info(`跳过项目记忆初始化 ${session.id}`);
      return;
    }
    const readParentDirectory = decision.outcome.optionId.endsWith("with_parent");
    const useMentionedDirectory = decision.outcome.optionId.startsWith("initialize_in_mentioned");
    const initRoot = useMentionedDirectory ? initializationDirectory : session.cwd;
    const missingPaths = missing.map((file) => relative(session.cwd, join(initRoot, file)) || file);

    // The initialization turn lets the model inspect the project before writing
    // durable instructions/context. The user's actual prompt runs afterwards.
    const previousWritePermission = session.permissions.get("write_file");
    session.permissions.set("write_file", "allow");
    session.messages.push({
      role: "user",
      content: [
        `这是项目首次初始化。请先检查初始化根目录（${initRoot}）的 README、源码结构、配置和已有文档，理解项目后创建缺失的项目记忆文件。${readParentDirectory ? `请读取工作目录的上层目录（${parentCwd}）以判断项目边界或补充背景；不要读取更上层目录。` : "不要读取工作目录的上层目录。"}`,
        `只创建这些缺失文件：${missingPaths.join(", ")}。`,
        "AGENTS.md 保存项目工作规则、技术栈和目录约定；.zhente/memory.md 保存项目背景、当前状态、重要决策和待办事项。不要修改其他文件，完成后简要说明。",
      ].join("\n"),
    });
    await this.persist(session);
    try {
      await runTurn({
        conn: this.#conn,
        session,
        provider: this.#provider,
        tools: new ToolRegistry(this.#builtinTools.filter((tool) => ["read_file", "list_dir", "glob", "grep", "write_file"].includes(tool.name))),
        config: { ...this.#config.agent, maxIterations: Math.min(this.#config.agent.maxIterations, 12) },
        signal: new AbortController().signal,
      });
    } finally {
      if (previousWritePermission) session.permissions.set("write_file", previousWritePermission);
      else session.permissions.delete("write_file");
    }
    const system = session.messages.find((message) => message.role === "system");
    if (system) system.content = await this.systemPrompt(session.cwd, session.skills, initRoot);
    await this.persist(session);
    logger.info(`项目记忆初始化完成 ${session.id}`);
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.#sessions.get(params.sessionId);
    session?.abort?.abort();
    logger.info(`cancel ${params.sessionId}`);
  }

  // No authentication required (we advertise no authMethods), but the ACP Agent
  // interface requires the method to exist.
  async authenticate(): Promise<void> {
    /* no-op */
  }

  /**
   * Close every session's MCP connections. ACP 0.4.5 has no session-end event,
   * so this runs once on process exit (see index.ts) rather than per session.
   */
  async shutdown(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((s) => s.dispose()));
  }
}

/** Find one explicit directory reference in the user's prompt, if it exists. */
async function findMentionedDirectory(prompt: string, cwd: string): Promise<string | null> {
  const candidates = new Set<string>();
  const add = (value: string | undefined) => {
    const candidate = value?.trim().replace(/[，。！？、；：,.;:!?)}\]】》]+$/u, "");
    if (candidate) candidates.add(candidate);
  };

  // Paths in backticks and path-like tokens (including absolute paths).
  for (const match of prompt.matchAll(/`([^`]+)`|(?<!\S)((?:\/|\.\.?\/)[^\s，。！？、；：,.;:!?)}\]】》]+)/gu)) {
    add(match[1] ?? match[2]);
  }
  // Also recognize natural-language references such as “在 src 目录下”.
  for (const match of prompt.matchAll(/(?:在|到|于|针对)\s*[“"「『]?([^\s，。！？、；：,.;:!?)}\]】》]+)\s*(?:目录|文件夹)/gu)) {
    add(match[1]);
  }

  for (const candidate of candidates) {
    const path = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
    if (path === resolve(cwd)) continue;
    try {
      if ((await stat(path)).isDirectory()) return path;
    } catch {
      // A non-existent path is not sufficiently unambiguous to change the
      // initialization target; let the normal prompt handle it instead.
    }
  }
  return null;
}

function defaultSystemPrompt(cwd: string): string {
  return [
    "你是 ZhenTe，一个运行在终端里的编程助手，通过 ACP 协议与编辑器协作。",
    `当前工作目录: ${cwd}`,
    "",
    "工作方式:",
    "- 通过提供的工具来查看和修改代码，不要臆测文件内容——先用 read_file/list_dir/glob/grep 确认。",
    "- 修改文件优先用 edit_file 做最小化的精确改动；创建新文件用 write_file。",
    "- 需要运行命令(构建/测试/git 等)时用 bash。",
    "- 任务复杂时用 update_plan 拆解步骤并随进度更新状态。",
    "- 涉及项目架构、重要决策或未完成事项时，完成任务后更新 AGENTS.md 或 .zhente/memory.md。",
    "- 路径可用相对当前工作目录的写法。",
    "- 回答简洁，用中文。完成后简要说明做了什么。",
  ].join("\n");
}
