import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { stat } from "node:fs/promises";
import {
  type Agent,
  type AuthMethod,
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
import { createHookRegistry, hookPayload } from "./hooks/index.js";
import type { HookOutcome } from "./hooks/types.js";
import { createProvider } from "./llm/factory.js";
import type { LLMProvider } from "./llm/types.js";
import { logger } from "./logger.js";
import { connectMcpServer } from "./mcp/client.js";
import { loadProjectMemory, loadUserMemory, missingProjectMemory } from "./project-memory.js";
import { loadSession as loadPersistedSession, persistHistoryReset, persistSession } from "./persistence.js";
import { type ClientCapabilities, Session } from "./session.js";
import { discoverSkills, skillCatalogPrompt, useSkillTool } from "./skills/index.js";
import { buildTools } from "./tools/index.js";

// SDK 0.4.5 strips clientCapabilities.auth and predates terminal method fields.
// Advertise unconditionally until an SDK upgrade can preserve auth.terminal.
type RegistryAuthMethod = AuthMethod & { type: "terminal"; args: string[] };
const AUTH_METHODS: RegistryAuthMethod[] = [{
  id: "terminal-setup",
  name: "在终端中配置（Terminal setup）",
  description: "配置 LLM provider 与 API key，无需浏览器；headless 环境可用。",
  type: "terminal",
  args: ["setup"],
  _meta: { "terminal-auth": true },
}];

/**
 * The ACP agent surface. It owns sessions and delegates the actual work of a
 * prompt turn to the harness ({@link runTurn}).
 */
export class SangxiaAgent implements Agent {
  readonly #conn: AgentSideConnection;
  readonly #loadedConfig: Config | null;
  readonly #configError: string | null;
  readonly #providers = new Map<string, LLMProvider>();
  readonly #builtinTools: Tool[];
  readonly #sessions = new Map<string, Session>();
  #clientCaps: ClientCapabilities = { readTextFile: false, writeTextFile: false, terminal: false };

  constructor(conn: AgentSideConnection, config: Config | null, configError: string | null = null) {
    this.#conn = conn;
    this.#loadedConfig = config;
    this.#configError = configError;
    this.#builtinTools = buildTools();
  }

  #requireConfig(): Config {
    if (!this.#loadedConfig) {
      throw RequestError.authRequired({
        reason: this.#configError ?? "未找到配置文件",
        hint: "在终端运行 `npx sangxia-ai setup` 完成配置",
      });
    }
    return this.#loadedConfig;
  }

  // Helpers only run for configured sessions; keep the same guard as entry points.
  get #config(): Config {
    return this.#requireConfig();
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
      authMethods: AUTH_METHODS,
      agentCapabilities: {
        loadSession: true,
        // stdio MCP is mandatory (no flag); advertise network transports too.
        mcpCapabilities: { http: true, sse: true },
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const config = this.#requireConfig();
    const id = randomUUID();
    return logger.withSession(id, async () => {
      const session = new Session(
        id,
        params.cwd,
        params.mcpServers ?? [],
        this.#clientCaps,
        config.agent.permissionMode,
        config.provider.model,
      );
      await this.prepareSession(session);
      await this.runSessionStart(session, "startup");
      session.messages.push({ role: "system", content: await this.systemPrompt(session) });
      this.#sessions.set(id, session);
      await persistSession(session);
      logger.info(`newSession ${id} cwd=${params.cwd} mcpServers=${session.mcpServers.length}`);
      return { sessionId: id, modes: permissionModes(session.permissionMode), models: this.modelState(session.modelId) };
    });
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const config = this.#requireConfig();
    const saved = await loadPersistedSession(params.sessionId);
    if (!saved) throw RequestError.invalidParams({ sessionId: `找不到已保存会话: ${params.sessionId}` });
    return logger.withSession(params.sessionId, async () => {
      const session = new Session(
        params.sessionId,
        params.cwd || saved.cwd,
        params.mcpServers ?? [],
        this.#clientCaps,
        saved.permissionMode ?? config.agent.permissionMode,
        this.isAvailableModel(saved.modelId) ? saved.modelId : config.provider.model,
      );
      await this.prepareSession(session);
      session.messages = saved.messages;
      session.startedToolCalls = saved.startedToolCalls ?? new Set();
      this.#sessions.set(session.id, session);
      await this.runSessionStart(session, "resume");
      // M2: a restored session has no systemPrompt() call, so session_start
      // context goes into the restored system message and is persisted with a
      // full-history replacement (an append-only log can't rewrite a message).
      if (session.hookContext.length > 0) {
        const system = session.messages.find((message) => message.role === "system");
        if (system) {
          system.content = [system.content, ...session.hookContext].filter(Boolean).join("\n\n");
          await persistHistoryReset(session);
        } else {
          logger.warn(`session ${session.id}: session_start 注入了上下文，但恢复的历史没有 system 消息可承载，已忽略`);
        }
      }
      logger.info(
        `loadSession ${session.id} cwd=${session.cwd} messages=${session.messages.length} ` +
          `startedToolCalls=${session.startedToolCalls.size} hookContext=${session.hookContext.length}`,
      );
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
    await persistSession(session);
    logger.info(`session ${session.id} permissionMode=${session.permissionMode} (permission memory cleared)`);
  }

  async setSessionModel(params: SetSessionModelRequest): Promise<void> {
    const session = this.#sessions.get(params.sessionId);
    if (!session) throw RequestError.invalidParams({ sessionId: `未知会话: ${params.sessionId}` });
    if (!this.isAvailableModel(params.modelId)) {
      throw RequestError.invalidParams({ modelId: `未知模型: ${params.modelId}` });
    }
    session.modelId = params.modelId;
    await persistSession(session);
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
    // Lifecycle hooks for this cwd (config-level commands were path-resolved in
    // loadConfig; the optional project-level file is read here, per session).
    session.hooks = createHookRegistry(this.#config.hooks, { cwd: session.cwd });

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

  /**
   * Assemble the system message.
   *
   * `session.hookContext` is appended here (not spliced into a string at
   * newSession time) so *every* rebuild carries it — including the rebuild after
   * project initialization overwrites the system message (review M2).
   */
  private async systemPrompt(session: Session, memoryCwd = session.cwd): Promise<string> {
    // 用户级指令（~/.config/sangxia/AGENTS.md）先、项目记忆后：后者更具体，
    // 冲突时靠后的说法"更近"，与 codex（全局 AGENTS.md → 项目 AGENTS.md）一致。
    const [userMemory, projectMemory] = await Promise.all([
      loadUserMemory().catch((e) => {
        logger.warn(`用户级指令读取失败: ${e instanceof Error ? e.message : String(e)}`);
        return "";
      }),
      loadProjectMemory(memoryCwd).catch((e) => {
        logger.warn(`项目记忆读取失败: ${e instanceof Error ? e.message : String(e)}`);
        return "";
      }),
    ]);
    return (
      (this.#config.agent.systemPrompt ?? defaultSystemPrompt(session.cwd)) +
      (session.hookContext.length > 0 ? `\n\n${session.hookContext.join("\n\n")}` : "") +
      skillCatalogPrompt(session.skills) +
      userMemory +
      projectMemory
    );
  }

  /**
   * Fire `session_start` and collect its injected context (best-effort).
   *
   * `source` 用 codex 的词汇表（`startup` = 新会话，`resume` = `session/load`），
   * 这样 `matcher: "startup|resume"` 这类配置可以照抄。
   */
  private async runSessionStart(session: Session, source: "startup" | "resume"): Promise<void> {
    if (!session.hooks.has("session_start")) return;
    const outcome = await session.hooks.run(
      "session_start",
      hookPayload(session, "session_start", {
        source,
        mcp_servers: session.mcpServers.map((server) => server.name),
        skills: session.skills.map((skill) => skill.name),
      }),
    );
    if (outcome.additionalContext.length > 0) {
      session.hookContext.push(...outcome.additionalContext);
      logger.info(`session ${session.id} session_start 注入上下文 ${outcome.additionalContext.length} 段`);
    }
    logHookErrors("session_start", session.id, outcome);
  }

  /** Fire `turn_end` (best-effort) — called on every `prompt()` exit path. */
  private async runTurnEnd(
    session: Session,
    stopReason: string,
    elapsedMs: number,
    turnKind: "main" | "init",
  ): Promise<void> {
    if (!session.hooks.has("turn_end")) return;
    const outcome = await session.hooks.run(
      "turn_end",
      hookPayload(session, "turn_end", {
        stop_reason: stopReason,
        iterations: session.turnIterations,
        elapsed_ms: elapsedMs,
        turn_kind: turnKind,
      }),
    );
    logHookErrors("turn_end", session.id, outcome);
  }

  /** Fire `session_end` for one session; caller bounds the total wait. */
  private async runSessionEnd(session: Session): Promise<void> {
    if (!session.hooks.has("session_end")) return;
    const outcome = await session.hooks.run(
      "session_end",
      hookPayload(session, "session_end", { reason: "shutdown" }),
    );
    logHookErrors("session_end", session.id, outcome);
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const config = this.#requireConfig();
    const session = this.#sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams({ sessionId: `未知会话: ${params.sessionId}` });
    }

    // H2: serialize prompts per session. Two concurrent turns would share
    // `session.messages` and interleave history; worse, whichever turn ends
    // first would null out the other's abort controller, so `session/cancel`
    // would silently stop working for the still-running turn.
    if (session.promptInFlight) {
      throw RequestError.invalidParams({ sessionId: "该会话已有 prompt 在运行中，请先取消或等待其结束" });
    }
    session.promptInFlight = true; // synchronous claim — no await between check and set
    const abort = new AbortController();
    session.abort = abort;
    try {
      // B3: one abort controller for the whole prompt turn — including the
      // project-initialization sub-turn. Previously that sub-turn used a fresh
      // AbortController, so Ctrl+C during a first-time init did nothing (the
      // UI appeared hung for up to 12 iterations). Sharing session.abort lets
      // session/cancel reach it like any other turn.
      // The claim happens outside `withSession` so the invariant doesn't rely on
      // AsyncLocalStorage running its callback synchronously.
      return await logger.withSession(params.sessionId, async () => {
        const turnStartedAt = Date.now();
        // A denied prompt runs no iteration; resetting keeps turn_end honest
        // (the field is written by the harness loop of the *last* turn).
        session.turnIterations = 0;
        let text = promptToText(params.prompt);
        let stopReason: PromptResponse["stopReason"];

        // user_prompt_submit fires *before* maybeInitializeProject (review M7):
        // a prompt that is going to be denied must not first drive a
        // 12-iteration initialization turn (permission prompts, LLM spend,
        // files written). The rewritten prompt is what every later step sees.
        let deniedByHook: HookOutcome | null = null;
        if (session.hooks.has("user_prompt_submit")) {
          const outcome = await session.hooks.run(
            "user_prompt_submit",
            hookPayload(session, "user_prompt_submit", { prompt: text }),
            { signal: abort.signal },
          );
          if (outcome.decision === "deny") {
            deniedByHook = outcome;
          } else if (outcome.updatedPrompt !== undefined && outcome.updatedPrompt !== text) {
            logger.info(
              `prompt ${params.sessionId} 被 hook "${outcome.hookName ?? "?"}" 改写 ` +
                `(${text.length} → ${outcome.updatedPrompt.length} 字符)`,
            );
            text = outcome.updatedPrompt;
          }
          logHookErrors("user_prompt_submit", params.sessionId, outcome);
        }

        if (deniedByHook) {
          const label = deniedByHook.hookName ?? "hook";
          const message = deniedByHook.reason?.trim()
            ? `被 hook ${label} 拒绝：${deniedByHook.reason}`
            : `被 hook ${label} 拒绝`;
          logger.warn(`prompt ${params.sessionId} 被 hook 拒绝: ${deniedByHook.reason ?? "(无原因)"}`);
          await this.notice(session, `[提示被拦截] ${message}`);
          stopReason = "refusal";
        } else {
          await this.maybeInitializeProject(session, text, abort.signal);
          session.messages.push({ role: "user", content: text });
          await persistSession(session);
          if (abort.signal.aborted) {
            logger.info(`prompt ${params.sessionId} cancelled during initialization`);
            stopReason = "cancelled";
          } else {
            stopReason = await runTurn({
              conn: this.#conn,
              session,
              provider: this.providerFor(session.modelId),
              tools: session.tools,
              config: config.agent,
              signal: abort.signal,
              hooks: session.hooks,
            });
          }
        }

        // M3: every exit path of prompt() reports exactly one turn_end —
        // including "cancelled during initialization" and "denied by hook".
        await this.runTurnEnd(session, stopReason, Date.now() - turnStartedAt, "main");
        await persistSession(session);
        logger.info(`prompt ${params.sessionId} → ${stopReason}`);
        return { stopReason };
      });
    } finally {
      if (session.abort === abort) session.abort = null; // only clear our own reference
      session.promptInFlight = false;
    }
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
        "AGENTS.md 保存项目工作规则、技术栈和目录约定；.sangxia/memory.md 保存项目背景、当前状态、重要决策和待办事项。不要修改其他文件，完成后简要说明。",
      ].join("\n"),
    });
    await persistSession(session);
    const initStartedAt = Date.now();
    try {
      const initStopReason = await runTurn({
        conn: this.#conn,
        session,
        provider: this.providerFor(session.modelId),
        tools: new ToolRegistry(this.#builtinTools.filter((tool) => ["read_file", "list_dir", "glob", "grep", "write_file"].includes(tool.name))),
        config: { ...this.#config.agent, maxIterations: Math.min(this.#config.agent.maxIterations, 12) },
        signal,
        hooks: session.hooks,
      });
      // M3: the initialization sub-turn is a real turn — audit it separately
      // (its write_file calls would otherwise never show up in turn_end).
      await this.runTurnEnd(session, initStopReason, Date.now() - initStartedAt, "init");
    } finally {
      if (previousWritePermission) session.permissions.set("write_file", previousWritePermission);
      else session.permissions.delete("write_file");
    }
    const system = session.messages.find((message) => message.role === "system");
    if (system) system.content = await this.systemPrompt(session, initRoot);
    await persistSession(session);
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
  //   时，stdin 为 TTY 则直接进入 `sangxia setup` 交互向导，否则返回引导说明；已认证
  //   状态返回成功即可（见 plan/acpreg.md §2.2、§3 阶段 2）。
  async authenticate(): Promise<void> {
    /* no-op */
  }

  /**
   * Extension request handler. ACP 扩展点（客户端发 `_<method>` 请求）。
   *
   * 目前只登记 `sangxia.set_model`：ACP SDK 0.4.5 的 ClientSideConnection.setSessionModel
   * 辅助方法错发 `session/set_mode`（见 .sangxia/memory.md），TUI 客户端因此改走扩展方法
   * 通道转发到同一 setSessionModel —— 语义与标准 `session/set_model` 完全一致（同样的
   * modelId 校验/持久化/日志），不是旁路 API。
   */
  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === "sangxia.set_model") {
      await this.setSessionModel(params as unknown as SetSessionModelRequest);
      return {};
    }
    throw RequestError.methodNotFound(`_${method}`);
  }

  /**
   * Fire `session_end` (best-effort, ≤2s total) and close every session's MCP
   * connections. ACP 0.4.5 has no session-end event, so this runs once on
   * process exit (see index.ts) rather than per session.
   */
  async shutdown(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    for (const session of sessions) session.abort?.abort();
    // Hard cap: a hanging hook must never hold the process open (plan §3).
    await Promise.race([
      Promise.all(sessions.map((session) => this.runSessionEnd(session))),
      new Promise<void>((resolve) => {
        setTimeout(resolve, SESSION_END_TIMEOUT_MS).unref?.();
      }),
    ]);
    await Promise.all(sessions.map((s) => s.dispose()));
  }

  /** Surface a plain text notice to the client (best-effort). */
  private async notice(session: Session, message: string): Promise<void> {
    try {
      await this.#conn.sessionUpdate({
        sessionId: session.id,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n${message}` } },
      });
    } catch (e) {
      logger.warn(`sessionUpdate 发送失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** `session_end` 的硬上限：超时放弃，绝不拖住进程退出。 */
const SESSION_END_TIMEOUT_MS = 2000;

/** 把 hook 执行失败集中记一条日志（hook 失败绝不影响 turn 收敛）。 */
function logHookErrors(event: string, sessionId: string, outcome: HookOutcome): void {
  if (outcome.errors.length > 0) {
    logger.warn(`hook ${event} 有 ${outcome.errors.length} 条失败记录 (session=${sessionId}): ${outcome.errors.join("; ")}`);
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
    "你是 桑夏AI，一个运行在终端里的猫咪编程助手，通过 ACP 协议与编辑器协作。",
    `当前工作目录: ${cwd}`,
    "",
    "工作方式:",
    "- 通过提供的工具来查看和修改代码，不要臆测文件内容——先用 read_file/list_dir/glob/grep 确认。",
    "- 修改文件优先用 edit_file 做最小化的精确改动；创建新文件用 write_file。",
    "- 需要运行命令(构建/测试/git 等)时用 bash。",
    "- 任务复杂时用 update_plan 拆解步骤并随进度更新状态。",
    "- 涉及项目架构、重要决策或未完成事项时，完成任务后更新 AGENTS.md 或 .sangxia/memory.md。",
    "- 路径可用相对当前工作目录的写法。",
    "- 回答简洁，用中文。完成后简要说明做了什么。" +
    "- 最后记得喵一下。",
  ].join("\n");
}
