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
  type SessionModeState,
  type SetSessionModeRequest,
  type SessionModelState,
  type SetSessionModelRequest,
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
  readonly #providers = new Map<string, LLMProvider>();
  readonly #builtinTools: Tool[];
  readonly #sessions = new Map<string, Session>();
  #clientCaps: ClientCapabilities = { readTextFile: false, writeTextFile: false, terminal: false };

  constructor(conn: AgentSideConnection, config: Config) {
    this.#conn = conn;
    this.#config = config;
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
    // TODO(acpreg): ACP 注册准入 —— initialize 响应需声明 authMethods（Terminal Auth：
    //   { id: "terminal-setup", name, description }），否则无法通过 registry CI 的
    //   authMethods 校验（见 plan/acpreg.md §2.2、§3 阶段 2）。
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
    // TODO(acpreg): 未认证（unconfigured）时拒绝建会话，返回 AUTH_REQUIRED 错误并
    //   提示运行 `zhente setup`（见 plan/acpreg.md §2.2、§3 阶段 2）。
    const id = randomUUID();
    return logger.withSession(id, async () => {
      const session = new Session(
        id,
        params.cwd,
        params.mcpServers ?? [],
        this.#clientCaps,
        this.#config.agent.permissionMode,
        this.#config.provider.model,
      );
      await this.prepareSession(session);
      session.messages.push({ role: "system", content: await this.systemPrompt(params.cwd, session.skills) });
      this.#sessions.set(id, session);
      await this.persist(session);
      logger.info(`newSession ${id} cwd=${params.cwd} mcpServers=${session.mcpServers.length}`);
      return { sessionId: id, modes: permissionModes(session.permissionMode), models: this.modelState(session.modelId) };
    });
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const saved = await loadPersistedSession(params.sessionId);
    if (!saved) throw RequestError.invalidParams({ sessionId: `找不到已保存会话: ${params.sessionId}` });
    return logger.withSession(params.sessionId, async () => {
      const session = new Session(
        params.sessionId,
        params.cwd || saved.cwd,
        params.mcpServers ?? [],
        this.#clientCaps,
        saved.permissionMode ?? this.#config.agent.permissionMode,
        this.isAvailableModel(saved.modelId) ? saved.modelId : this.#config.provider.model,
      );
      await this.prepareSession(session);
      session.messages = saved.messages;
      this.#sessions.set(session.id, session);
      logger.info(`loadSession ${session.id} cwd=${session.cwd} messages=${session.messages.length}`);
      return { modes: permissionModes(session.permissionMode), models: this.modelState(session.modelId) };
    });
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<void> {
    const session = this.#sessions.get(params.sessionId);
    if (!session) throw RequestError.invalidParams({ sessionId: `未知会话: ${params.sessionId}` });
    if (params.modeId !== "confirm" && params.modeId !== "auto") {
      throw RequestError.invalidParams({ modeId: `未知权限模式: ${params.modeId}` });
    }
    session.permissionMode = params.modeId;
    // N1: switching access mode resets remembered "always allow/reject"
    // decisions — the recovery path for an accidental "always reject" (the
    // ACP protocol has no message to read/clear that map).
    session.permissions.clear();
    await this.persist(session);
    logger.info(`session ${session.id} permissionMode=${session.permissionMode} (permission memory cleared)`);
  }

  async setSessionModel(params: SetSessionModelRequest): Promise<void> {
    const session = this.#sessions.get(params.sessionId);
    if (!session) throw RequestError.invalidParams({ sessionId: `未知会话: ${params.sessionId}` });
    if (!this.isAvailableModel(params.modelId)) {
      throw RequestError.invalidParams({ modelId: `未知模型: ${params.modelId}` });
    }
    session.modelId = params.modelId;
    await this.persist(session);
    logger.info(`session ${session.id} model=${session.modelId}`);
  }

  private availableModels() {
    return this.#config.provider.models ?? [
      { modelId: this.#config.provider.model, name: this.#config.provider.model },
    ];
  }

  private isAvailableModel(modelId: string | undefined): modelId is string {
    return modelId !== undefined && this.availableModels().some((model) => model.modelId === modelId);
  }

  private modelState(currentModelId: string): SessionModelState {
    return { currentModelId, availableModels: this.availableModels() };
  }

  private providerFor(modelId: string): LLMProvider {
    let provider = this.#providers.get(modelId);
    if (!provider) {
      provider = createProvider({ ...this.#config.provider, model: modelId });
      this.#providers.set(modelId, provider);
    }
    return provider;
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
    // Diagnostic used by scripts/smoke-mcp.mjs to verify MCP + skill wiring.
    logger.info(
      `session ${session.id} 工具集: builtin=${this.#builtinTools.length} ` +
        `skills=${session.skills.length} mcpTools=${mcpTools.length}`,
    );
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
      await saveSession({
        version: 1,
        sessionId: session.id,
        cwd: session.cwd,
        messages: session.messages,
        permissionMode: session.permissionMode,
        modelId: session.modelId,
        updatedAt: new Date().toISOString(),
      });
    } catch (e) {
      logger.warn(`session ${session.id} 持久化失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    // TODO(acpreg): 未认证（unconfigured）时 prompt 返回 AUTH_REQUIRED JSON-RPC 错误
    //   （含 type:"terminal"、args:["setup"] 声明），而不是继续运行（见 plan/acpreg.md
    //   §2.2、§3 阶段 2）。
    const session = this.#sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams({ sessionId: `未知会话: ${params.sessionId}` });
    }

    return logger.withSession(params.sessionId, async () => {
      const text = promptToText(params.prompt);

      // B3: one abort controller for the whole prompt turn — including the
      // project-initialization sub-turn. Previously that sub-turn used a fresh
      // AbortController, so Ctrl+C during a first-time init did nothing (the
      // UI appeared hung for up to 12 iterations). Sharing session.abort lets
      // session/cancel reach it like any other turn.
      const abort = new AbortController();
      session.abort = abort;
      try {
        await this.maybeInitializeProject(session, text, abort.signal);
        session.messages.push({ role: "user", content: text });
        await this.persist(session);
        if (abort.signal.aborted) {
          logger.info(`prompt ${params.sessionId} cancelled during initialization`);
          return { stopReason: "cancelled" };
        }
        const stopReason = await runTurn({
          conn: this.#conn,
          session,
          provider: this.providerFor(session.modelId),
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
    });
  }

  private async maybeInitializeProject(session: Session, prompt: string, signal: AbortSignal): Promise<void> {
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
        provider: this.providerFor(session.modelId),
        tools: new ToolRegistry(this.#builtinTools.filter((tool) => ["read_file", "list_dir", "glob", "grep", "write_file"].includes(tool.name))),
        config: { ...this.#config.agent, maxIterations: Math.min(this.#config.agent.maxIterations, 12) },
        signal,
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
    return logger.withSession(params.sessionId, () => {
      const session = this.#sessions.get(params.sessionId);
      session?.abort?.abort();
      logger.info(`cancel ${params.sessionId}`);
    });
  }

  // TODO(acpreg): ACP 注册准入 —— 实现 Terminal Auth 认证：methodId === "terminal-setup"
  //   时，stdin 为 TTY 则直接进入 `zhente setup` 交互向导，否则返回引导说明；已认证
  //   状态返回成功即可（见 plan/acpreg.md §2.2、§3 阶段 2）。
  async authenticate(): Promise<void> {
    /* no-op */
  }

  /**
   * Extension request handler. ACP 扩展点（客户端发 `_<method>` 请求）。
   *
   * 目前只登记 `zhente.set_model`：ACP SDK 0.4.5 的 ClientSideConnection.setSessionModel
   * 辅助方法错发 `session/set_mode`（见 .zhente/memory.md），TUI 客户端因此改走扩展方法
   * 通道转发到同一 setSessionModel —— 语义与标准 `session/set_model` 完全一致（同样的
   * modelId 校验/持久化/日志），不是旁路 API。
   */
  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === "zhente.set_model") {
      await this.setSessionModel(params as unknown as SetSessionModelRequest);
      return {};
    }
    throw RequestError.methodNotFound(`_${method}`);
  }

  /**
   * Close every session's MCP connections. ACP 0.4.5 has no session-end event,
   * so this runs once on process exit (see index.ts) rather than per session.
   */
  async shutdown(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((s) => s.dispose()));
  }
}

function permissionModes(currentModeId: Session["permissionMode"]): SessionModeState {
  return {
    currentModeId,
    availableModes: [
      { id: "confirm", name: "Standard Access", description: "变更操作执行前请求确认" },
      { id: "auto", name: "Full Access", description: "自动批准变更操作（危险）" },
    ],
  };
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
