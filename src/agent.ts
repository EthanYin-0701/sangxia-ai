import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { stat } from "node:fs/promises";
import {
  type AuthMethod,
  type AuthenticateRequest,
  type AuthenticateResponse,
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
  type SessionConfigOption,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import type { ClientChannel } from "./acp/client-channel.js";
import { promptToText } from "./acp/content.js";
import type { Config } from "./config.js";
import { effortOption, isAllowedEffort, modelEfforts, type EffortChoices } from "./efforts.js";
import { runTurn } from "./harness/loop.js";
import { type Tool, ToolRegistry } from "./harness/tool.js";
import { createHookRegistry, hookPayload, type HookRegistry } from "./hooks/index.js";
import type { HookOutcome } from "./hooks/types.js";
import { createProvider } from "./llm/factory.js";
import type { LLMProvider } from "./llm/types.js";
import { logger } from "./logger.js";
import { connectMcpServer } from "./mcp/client.js";
import { loadProjectMemory, loadUserMemory, missingProjectMemory } from "./project-memory.js";
import {
  forgetSessionTracking,
  isFullyPersisted,
  loadSession as loadPersistedSession,
  persistHistoryReset,
  persistSession,
} from "./persistence.js";
import { type ClientCapabilities, type PermissionDecision, type PermissionMode, Session } from "./session.js";
import { discoverSkills, skillCatalogPrompt, useSkillTool } from "./skills/index.js";
import { buildTools } from "./tools/index.js";
import { canonicalPath, dirPermissionKey } from "./tools/scope.js";
import { resolveShell, shellSyntaxHint } from "./tools/shell.js";
import { AGENT_INFO } from "./version.js";

type RegistryAuthMethod = AuthMethod & { type: "terminal"; args: string[] };

/**
 * ACP v1 (protocol/v1/authentication): an agent may advertise a `terminal`
 * auth method only when the client enabled terminal-auth support. SDK 2.7.0
 * exposes the standard `clientCapabilities.auth.terminal` flag (SA-65); older
 * clients (legacy Zed, the ACP Registry validator) opt in through the
 * `_meta["terminal-auth"]` convention instead. Accept either so a spec client
 * and a legacy one both get the methods, while a client that signals neither
 * sees none (the `#requireConfig()` error message is the fallback there).
 */
function clientSupportsTerminalAuth(caps: InitializeRequest["clientCapabilities"]): boolean {
  if (caps?.auth?.terminal === true) return true;
  const meta = caps?._meta as { "terminal-auth"?: unknown } | undefined;
  return meta?.["terminal-auth"] === true;
}
/**
 * There is no session to talk through before authentication, so `name` /
 * `description` here are the only guaranteed place a client renders guidance,
 * and the `auth_required` message (see `#requireConfig`) is the error-path
 * fallback. DeepSeek comes first: ACP has no "API key" method type
 * (protocol/v1/authentication: only `agent` and `terminal`), and form
 * elicitation is forbidden for secrets, so a preset terminal flow is the
 * complaint-free way to collect just a key.
 */
const AUTH_METHODS: RegistryAuthMethod[] = [{
  id: "deepseek-setup",
  name: "使用 DeepSeek API Key 登录",
  description:
    "点击后在终端运行 npx sangxia-ai setup --preset deepseek：只需粘贴 DeepSeek API Key" +
    "（platform.deepseek.com → API keys）。端点与模型已预填（https://api.deepseek.com · deepseek-flash），" +
    "保存前会检查连通性；完成后回到编辑器重新连接。",
  type: "terminal",
  args: ["setup", "--preset", "deepseek"],
  _meta: { "terminal-auth": true },
}, {
  id: "terminal-setup",
  name: "在终端中配置其它 OpenAI 兼容端点（Terminal setup）",
  description: "交互式配置 provider、base URL、model 与 API key，无需浏览器；headless 环境可用。",
  type: "terminal",
  args: ["setup"],
  _meta: { "terminal-auth": true },
}];

/**
 * Legacy model-selector shapes. SDK 2.x dropped `models` / `session/set_model`
 * from the stable schema, but AIR's model dropdown still reads `models` from
 * session/new|load and sends `session/set_model`, so we keep emitting and
 * accepting them (outbound responses are not schema-checked) alongside the
 * standard `configOptions` (SA-65).
 */
export interface ModelInfo {
  modelId: string;
  name: string;
  description?: string | null;
}
export interface SessionModelState {
  currentModelId: string;
  availableModels: ModelInfo[];
}
export interface SetSessionModelRequest {
  sessionId: string;
  modelId: string;
}

/**
 * What stays in memory for an idle-evicted session (SA-7): only what the JSONL
 * log does not record and a few small fields, never the history or any MCP
 * connection. The client is not told about eviction, so the next request for
 * the id rebuilds a full {@link Session} from this plus the log.
 */
interface EvictedSession {
  id: string;
  cwd: string;
  mcpServers: Session["mcpServers"];
  clientCaps: ClientCapabilities;
  permissionMode: PermissionMode;
  modelId: string;
  effort: string | null;
  /** "Always allow/reject" memory is not persisted, so it survives eviction here. */
  permissions: Map<string, PermissionDecision>;
  historyWarned: boolean;
  initializationChecked: boolean;
  hookContext: string[];
  /** Kept so `shutdown` can still fire `session_end` for this session. */
  hooks: HookRegistry;
}

/**
 * The ACP agent surface. It owns sessions and delegates the actual work of a
 * prompt turn to the harness ({@link runTurn}). Transport-free: the wire
 * routing lives in `acp/agent-app.ts`.
 */
export class SangxiaAgent {
  readonly #conn: ClientChannel;
  readonly #loadedConfig: Config | null;
  readonly #configError: string | null;
  readonly #providers = new Map<string, LLMProvider>();
  readonly #builtinTools: Tool[];
  readonly #sessions = new Map<string, Session>();
  /** Idle-evicted sessions, rebuilt on demand (SA-7). */
  readonly #evicted = new Map<string, EvictedSession>();
  /** In-flight rebuilds, so concurrent requests share one restored Session. */
  readonly #restoring = new Map<string, Promise<Session | undefined>>();
  /** Sessions cancelled while being restored from an idle eviction (SA-7). */
  readonly #cancelledWhileRestoring = new Set<string>();
  #idleTimer: ReturnType<typeof setInterval> | null = null;
  #clientCaps: ClientCapabilities = { readTextFile: false, writeTextFile: false, terminal: false };

  constructor(conn: ClientChannel, config: Config | null, configError: string | null = null) {
    this.#conn = conn;
    this.#loadedConfig = config;
    this.#configError = configError;
    this.#builtinTools = buildTools();
  }

  #requireConfig(): Config {
    const config = this.#loadedConfig;
    if (!config || (config.provider.type !== "mock" && !config.provider.apiKey?.trim())) {
      const reason = this.#configError ?? (config ? "provider.apiKey 为空" : "未找到配置文件");
      // RequestError.authRequired() hardcodes "Authentication required" and the
      // message is the field most clients actually render, so spell the way out
      // both there and in `data` (some clients only surface one of the two).
      throw new RequestError(-32000,
        "Authentication required: 运行 `npx sangxia-ai setup --preset deepseek` 输入 DeepSeek API Key" +
        "（或在编辑器的认证列表中选择“使用 DeepSeek API Key 登录”）。",
        {
          reason,
          hint: "在终端运行 `npx sangxia-ai setup --preset deepseek` 配置 DeepSeek，" +
            "或用 `npx sangxia-ai setup` 配置其它 OpenAI 兼容端点",
        });
    }
    return config;
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
    // Terminal auth methods are advertised only to clients that support them
    // (SA-58). All current AUTH_METHODS are `type: "terminal"`, so this is
    // all-or-nothing today; non-terminal methods would pass through unchanged.
    const terminalAuth = clientSupportsTerminalAuth(params.clientCapabilities);
    const authMethods = AUTH_METHODS.filter((m) => m.type !== "terminal" || terminalAuth);
    logger.info(`initialize: terminal auth ${terminalAuth ? "advertised" : "withheld"} (${authMethods.length} method(s))`);
    const response = {
      agentInfo: AGENT_INFO,
      protocolVersion: PROTOCOL_VERSION,
      authMethods,
      agentCapabilities: {
        loadSession: true,
        // stdio MCP is mandatory (no flag); advertise network transports too.
        mcpCapabilities: { http: true, sse: true },
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
    };
    return response;
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse & { models: SessionModelState }> {
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
      session.effort = this.effortFor(session.modelId)?.default ?? null;
      await this.prepareSession(session);
      await this.runSessionStart(session, "startup");
      session.messages.push({ role: "system", content: await this.systemPrompt(session) });
      this.registerSession(session);
      await persistSession(session);
      logger.info(`newSession ${id} cwd=${params.cwd} mcpServers=${session.mcpServers.length}`);
      return { sessionId: id, modes: permissionModes(session.permissionMode), models: this.modelState(session.modelId), configOptions: this.configOptions(session) };
    });
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse & { models: SessionModelState }> {
    const config = this.#requireConfig();
    return logger.withSession(params.sessionId, async () => {
      // SA-12: loading an id that is already live (editor reconnect, double
      // load) replaces that Session. Retire the old one *before* reading the
      // log, so its MCP connections are closed instead of leaked and its
      // aborted turn has finished writing the history we are about to replay.
      // An explicit load supersedes an idle-evicted stub (SA-7): wait for a
      // rebuild already running on it, then load from the log as usual.
      await this.#restoring.get(params.sessionId)?.catch(() => undefined);
      this.#evicted.delete(params.sessionId);
      this.#cancelledWhileRestoring.delete(params.sessionId);
      const previous = this.#sessions.get(params.sessionId);
      if (previous) await this.retireSession(previous, "被 session/load 替换");
      const saved = await loadPersistedSession(params.sessionId);
      if (!saved) throw RequestError.invalidParams({ sessionId: `找不到已保存会话: ${params.sessionId}` });
      const session = new Session(
        params.sessionId,
        params.cwd || saved.cwd,
        params.mcpServers ?? [],
        this.#clientCaps,
        saved.permissionMode ?? config.agent.permissionMode,
        this.isAvailableModel(saved.modelId) ? saved.modelId : config.provider.model,
      );
      // Effort is vendor-defined, so a saved value is only reused while the
      // (possibly changed) model still offers it.
      const efforts = this.effortFor(session.modelId);
      session.effort = efforts
        ? (saved.effort && isAllowedEffort(efforts, saved.effort) ? saved.effort : efforts.default)
        : null;
      await this.prepareSession(session);
      session.messages = saved.messages;
      session.startedToolCalls = saved.startedToolCalls ?? new Set();
      this.registerSession(session);
      if (previous) this.pruneProviders();
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
      return { modes: permissionModes(session.permissionMode), models: this.modelState(session.modelId), configOptions: this.configOptions(session) };
    });
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<void> {
    const session = await this.liveSession(params.sessionId);
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
    await this.#conn.sessionUpdate({
      sessionId: session.id,
      update: { sessionUpdate: "current_mode_update", currentModeId: session.permissionMode },
    });
    await this.#conn.sessionUpdate({
      sessionId: session.id,
      update: { sessionUpdate: "config_option_update", configOptions: this.configOptions(session) },
    });
    // Clear any cancel flag set during a non-prompt rebuild (e.g. setSessionMode triggered restore).
    this.#cancelledWhileRestoring.delete(params.sessionId);
  }

  async setSessionModel(params: SetSessionModelRequest): Promise<void> {
    const session = await this.liveSession(params.sessionId);
    if (!session) throw RequestError.invalidParams({ sessionId: `未知会话: ${params.sessionId}` });
    if (!this.isAvailableModel(params.modelId)) {
      throw RequestError.invalidParams({ modelId: `未知模型: ${params.modelId}` });
    }
    session.modelId = params.modelId;
    this.resyncEffort(session);
    this.pruneProviders();
    await persistSession(session);
    logger.info(`session ${session.id} model=${session.modelId} effort=${session.effort ?? "n/a"}`);
    await this.#conn.sessionUpdate({
      sessionId: session.id,
      update: { sessionUpdate: "config_option_update", configOptions: this.configOptions(session) },
    });
    // Clear any cancel flag set during a non-prompt rebuild.
    this.#cancelledWhileRestoring.delete(params.sessionId);
  }

  /**
   * Switch the reasoning effort (`reasoning_effort`) for this session. Only
   * models that declare `efforts` in the config expose the option, so an
   * unknown value here is a client bug and stays a -32602.
   */
  private async setSessionEffort(session: Session, effort: string): Promise<void> {
    const efforts = this.effortFor(session.modelId);
    if (!efforts) {
      throw RequestError.invalidParams({ configId: `模型 ${session.modelId} 未配置 effort 选项` });
    }
    if (!isAllowedEffort(efforts, effort)) {
      throw RequestError.invalidParams({ value: `未知 effort: ${effort}（可选: ${efforts.values.join(", ")}）` });
    }
    if (session.effort === effort) return;
    session.effort = effort;
    await persistSession(session);
    logger.info(`session ${session.id} effort=${effort}`);
    await this.#conn.sessionUpdate({
      sessionId: session.id,
      update: { sessionUpdate: "config_option_update", configOptions: this.configOptions(session) },
    });
    // Clear any cancel flag set during a non-prompt rebuild.
    this.#cancelledWhileRestoring.delete(session.id);
  }

  /** Keep `session.effort` valid for the (possibly new) model. */
  private resyncEffort(session: Session): void {
    const efforts = this.effortFor(session.modelId);
    if (!efforts) {
      session.effort = null;
    } else if (!session.effort || !isAllowedEffort(efforts, session.effort)) {
      session.effort = efforts.default;
    }
  }

  /** Effort selector for a model, or null when it has none (see `src/efforts.ts`). */
  private effortFor(modelId: string): EffortChoices | null {
    return modelEfforts(this.#config.provider, modelId);
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    if (!(await this.liveSession(params.sessionId))) {
      throw RequestError.invalidParams({ sessionId: `未知会话: ${params.sessionId}` });
    }
    // Only string values are defined for the select options we expose; newer
    // SDKs widen `value` to `string | boolean`, so keep this a -32602 (SA-65).
    if (typeof params.value !== "string") {
      throw RequestError.invalidParams({ value: `配置值必须是字符串: ${JSON.stringify(params.value)}` });
    }
    if (params.configId === "model") {
      await this.setSessionModel({ sessionId: params.sessionId, modelId: params.value });
    } else if (params.configId === "mode") {
      await this.setSessionMode({ sessionId: params.sessionId, modeId: params.value });
    } else if (params.configId === "effort") {
      await this.setSessionEffort(this.#sessions.get(params.sessionId)!, params.value);
    } else {
      throw RequestError.invalidParams({ configId: `未知配置选项: ${params.configId}` });
    }
    return { configOptions: this.configOptions(this.#sessions.get(params.sessionId)!) };
  }

  /**
   * Standard `configOptions`. `model` and `mode` come first (clients such as
   * AIR key off those ids), and the `effort` selector is appended only when the
   * current model declares `efforts` in the config — a backend that doesn't
   * understand `reasoning_effort` never sees the option.
   */
  private configOptions(session: Session): SessionConfigOption[] {
    const options: SessionConfigOption[] = [{
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: session.modelId,
      options: this.availableModels().map(({ modelId, name, description }) => ({
        value: modelId, name, ...(description !== undefined ? { description } : {}),
      })),
    }, {
      id: "mode",
      name: "Access and mode",
      category: "mode",
      type: "select",
      currentValue: session.permissionMode,
      options: permissionModes(session.permissionMode).availableModes.map(({ id, name, description }) => ({
        value: id, name, ...(description !== undefined ? { description } : {}),
      })),
    }];
    const efforts = this.effortFor(session.modelId);
    if (efforts) {
      options.push({
        id: "effort",
        name: "Effort",
        description: "思考力度（reasoning_effort）：越高越深入，也越慢越贵",
        category: "thought_level",
        type: "select",
        currentValue: session.effort ?? efforts.default,
        options: efforts.values.map((value) => {
          const { name, description } = effortOption(value);
          return { value, name, ...(description !== undefined ? { description } : {}) };
        }),
      });
    }
    return options;
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

  /**
   * SA-13: drop cached providers that no live session has selected. A turn
   * already running keeps its own reference, so this never pulls a provider
   * out from under it; switching back simply creates a fresh one.
   */
  private pruneProviders(): void {
    const inUse = new Set([...this.#sessions.values()].map((session) => session.modelId));
    for (const modelId of this.#providers.keys()) {
      if (!inUse.has(modelId)) {
        this.#providers.delete(modelId);
        logger.debug(`provider cache: 释放未被任何会话使用的模型 ${modelId}`);
      }
    }
  }

  /** The live Session for an id, if any (diagnostics and tests). */
  getSession(sessionId: string): Session | undefined {
    return this.#sessions.get(sessionId);
  }

  /** Model ids with a cached provider (diagnostics and tests). */
  cachedProviderModels(): string[] {
    return [...this.#providers.keys()];
  }

  /**
   * Remove a session from the live map and release what it holds (SA-12):
   * abort its turn, wait (bounded) for that turn to finish writing, then close
   * its MCP connections. The caller prunes providers once the replacement
   * (if any) is registered, so a provider it reuses isn't recreated.
   */
  private async retireSession(session: Session, reason: string): Promise<void> {
    if (this.#sessions.get(session.id) === session) this.#sessions.delete(session.id);
    const running = session.promptInFlight;
    session.abort?.abort();
    if (running) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        session.turnSettled,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            logger.warn(`session ${session.id}: 等待旧 turn 结束超时（${RETIRE_TURN_TIMEOUT_MS}ms），继续释放`);
            resolve();
          }, RETIRE_TURN_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    }
    await session.dispose();
    logger.info(`session ${session.id} 已释放（${reason}）mcpConnections 已关闭 runningTurn=${running}`);
  }

  /** Put a session in the live map and make sure the idle sweep runs (SA-7). */
  private registerSession(session: Session): void {
    session.lastActivityAt = Date.now();
    this.#sessions.set(session.id, session);
    const idleMs = this.#config.agent.sessionIdleTimeoutMs ?? 0;
    if (idleMs > 0 && !this.#idleTimer) {
      this.#idleTimer = setInterval(() => {
        void this.evictIdleSessions().catch((e) => {
          logger.warn(`空闲会话回收失败: ${e instanceof Error ? e.message : String(e)}`);
        });
      }, Math.min(idleMs, IDLE_SWEEP_MAX_INTERVAL_MS));
      this.#idleTimer.unref?.();
    }
  }

  /**
   * The live Session for a client-supplied id, rebuilding an idle-evicted one
   * from its JSONL log (SA-7). Undefined = unknown id. Every entry point that
   * acts on a session goes through here, which also resets its idle clock.
   */
  private async liveSession(sessionId: string): Promise<Session | undefined> {
    const live = this.#sessions.get(sessionId);
    if (live) {
      live.lastActivityAt = Date.now();
      return live;
    }
    let pending = this.#restoring.get(sessionId);
    if (!pending) {
      const stub = this.#evicted.get(sessionId);
      if (!stub) return undefined;
      pending = logger.withSession(sessionId, () => this.restoreEvicted(stub))
        .finally(() => this.#restoring.delete(sessionId));
      this.#restoring.set(sessionId, pending);
    }
    const session = await pending;
    if (session) session.lastActivityAt = Date.now();
    return session;
  }

  /**
   * Rebuild an evicted session: history from the log, everything else from the
   * stub, tools/MCP/skills/hooks via `prepareSession` (MCP is thereby lazily
   * reconnected). `session_start` is not re-fired: to the client this is the
   * same session, and its earlier hook context is already in the system message.
   */
  private async restoreEvicted(stub: EvictedSession): Promise<Session | undefined> {
    // A read error may be transient: keep the stub (a later request retries)
    // and fail this request with an internal error rather than "unknown session".
    const saved = await loadPersistedSession(stub.id);
    if (this.#evicted.get(stub.id) !== stub) return this.#sessions.get(stub.id); // superseded by session/load
    this.#evicted.delete(stub.id);
    if (!saved) {
      logger.warn(`session ${stub.id}: 已被空闲回收且会话日志不可用，视为未知会话`);
      return undefined;
    }
    const session = new Session(stub.id, stub.cwd, stub.mcpServers, stub.clientCaps, stub.permissionMode, stub.modelId);
    session.effort = stub.effort;
    for (const [key, decision] of stub.permissions) session.permissions.set(key, decision);
    session.historyWarned = stub.historyWarned;
    session.initializationChecked = stub.initializationChecked;
    session.hookContext = stub.hookContext;
    try {
      await this.prepareSession(session);
    } catch (e) {
      await session.dispose();
      this.#evicted.set(stub.id, stub);
      this.#cancelledWhileRestoring.delete(stub.id);
      throw e;
    }
    session.messages = saved.messages;
    session.startedToolCalls = saved.startedToolCalls ?? new Set();
    this.registerSession(session);
    logger.info(`session ${session.id} 已从空闲回收中恢复 messages=${session.messages.length} mcpConnections=${session.mcpConnections.length}`);
    return session;
  }

  /**
   * SA-7: evict every live session idle for at least `agent.sessionIdleTimeoutMs`
   * that has no turn in flight and whose state is fully on disk. Its history and
   * MCP connections are released and its persistence bookkeeping dropped; a
   * small stub stays so the next request rebuilds it transparently. Runs from a
   * periodic unref'd timer; public with an injectable clock for tests.
   * Returns the evicted ids.
   */
  async evictIdleSessions(now = Date.now()): Promise<string[]> {
    const idleMs = this.#loadedConfig?.agent.sessionIdleTimeoutMs ?? 0;
    if (idleMs <= 0) return [];
    const evicted: string[] = [];
    for (const session of [...this.#sessions.values()]) {
      if (session.promptInFlight || now - session.lastActivityAt < idleMs) continue;
      await logger.withSession(session.id, async () => {
        // Re-check after the await: a request may have arrived meanwhile.
        if (this.#sessions.get(session.id) !== session || session.promptInFlight || now - session.lastActivityAt < idleMs) return;
        if (!isFullyPersisted(session)) {
          logger.warn(`session ${session.id}: 有未落盘的状态，暂不回收（最多晚一轮）`);
          return;
        }
        this.#evicted.set(session.id, {
          id: session.id,
          cwd: session.cwd,
          mcpServers: session.mcpServers,
          clientCaps: session.clientCaps,
          permissionMode: session.permissionMode,
          modelId: session.modelId,
          effort: session.effort,
          permissions: new Map(session.permissions),
          historyWarned: session.historyWarned,
          initializationChecked: session.initializationChecked,
          hookContext: session.hookContext,
          hooks: session.hooks,
        });
        this.#sessions.delete(session.id);
        forgetSessionTracking(session.id);
        await session.dispose();
        evicted.push(session.id);
        logger.info(`session ${session.id} 空闲超过 ${idleMs}ms，已回收（历史释放、MCP 连接已关闭，下次请求时从日志恢复）`);
      });
    }
    if (evicted.length > 0) this.pruneProviders();
    return evicted;
  }

  /** Ids of idle-evicted sessions (diagnostics and tests). */
  evictedSessionIds(): string[] {
    return [...this.#evicted.keys()];
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
  private async runSessionEnd(session: Pick<Session, "id" | "cwd" | "permissionMode" | "modelId" | "hooks">): Promise<void> {
    if (!session.hooks.has("session_end")) return;
    const outcome = await session.hooks.run(
      "session_end",
      hookPayload(session, "session_end", { reason: "shutdown" }),
    );
    logHookErrors("session_end", session.id, outcome);
  }

  /**
   * `signal` is the request's own cancellation (SDK `ctx.signal`: aborted by
   * `$/cancel_request` or a dropped connection). It is folded into the turn's
   * abort controller, so it stops the LLM stream and tools exactly like
   * `session/cancel` does and the turn still converges to `cancelled` with
   * every tool call answered and the history persisted.
   */
  async prompt(params: PromptRequest, signal?: AbortSignal): Promise<PromptResponse> {
    const config = this.#requireConfig();
    const session = await this.liveSession(params.sessionId);
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
    let settle: () => void = () => {};
    session.turnSettled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const abort = new AbortController();
    session.abort = abort;
    const onRequestAbort = () => {
      logger.withSession(params.sessionId, () => logger.info(`prompt ${params.sessionId}: 请求被取消（$/cancel_request 或连接断开）`));
      abort.abort();
    };
    if (signal?.aborted) onRequestAbort();
    else signal?.addEventListener("abort", onRequestAbort, { once: true });
    if (this.#cancelledWhileRestoring.delete(params.sessionId)) {
      abort.abort();
    }
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
      signal?.removeEventListener("abort", onRequestAbort);
      if (session.abort === abort) session.abort = null; // only clear our own reference
      this.#cancelledWhileRestoring.delete(params.sessionId);
      session.promptInFlight = false;
      session.lastActivityAt = Date.now(); // the idle clock starts when the turn ends
      settle();
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
    // SA-1: permission memory is scoped, so grant exactly what the user just
    // approved — writes under the initialization root, reads there (and in the
    // parent directory if they chose so) — instead of the whole tool.
    const grantDirs = [await canonicalPath(initRoot), ...(readParentDirectory ? [await canonicalPath(parentCwd)] : [])];
    const grantKeys = [
      dirPermissionKey("write_file", grantDirs[0]!),
      ...grantDirs.flatMap((dir) => ["read_file", "list_dir", "glob", "grep"].map((tool) => dirPermissionKey(tool, dir))),
    ];
    const previousGrants = new Map(grantKeys.map((key) => [key, session.permissions.get(key)]));
    for (const key of grantKeys) session.permissions.set(key, "allow");
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
      for (const [key, previous] of previousGrants) {
        if (previous) session.permissions.set(key, previous);
        else session.permissions.delete(key);
      }
    }
    const system = session.messages.find((message) => message.role === "system");
    if (system) {
      system.content = await this.systemPrompt(session, initRoot);
      await persistHistoryReset(session);
    }
    logger.info(`项目记忆初始化完成 ${session.id}`);
  }

  async cancel(params: CancelNotification): Promise<void> {
    return logger.withSession(params.sessionId, () => {
      const session = this.#sessions.get(params.sessionId);
      if (session) {
        session.abort?.abort();
      } else if (this.#restoring.has(params.sessionId)) {
        this.#cancelledWhileRestoring.add(params.sessionId);
      }
      logger.info(`cancel ${params.sessionId}`);
    });
  }

  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    // Both advertised methods are `terminal`: the client runs `setup` itself and
    // reconnects, so an `authenticate` request should only ever arrive from a
    // client that ignores the type. Stay lenient, but never claim success while
    // the config is still unusable (that would let `/new` fail later instead).
    if (params.methodId !== "terminal-setup" && params.methodId !== "deepseek-setup") {
      throw RequestError.invalidParams({ methodId: `未知认证方法: ${params.methodId}` });
    }
    // Terminal auth normally completes in a separate process followed by reconnect.
    this.#requireConfig();
    return {};
  }

  /**
   * Extension request handler. ACP 扩展点（客户端发 `_<method>` 请求），
   * 由 `acp/agent-app.ts` 的 `"*"` 兜底路由传入完整的 wire 方法名。
   *
   * 保留旧客户端的 `_sangxia.set_model` 以及未加前缀的内部调用，与标准切换
   * 逻辑共用。`session/set_model` 在 agent-app 中显式注册，不走这里。
   *
   * 这里拿到的 params 未经 SDK 的 zod 校验（可能是 null / 数组 / 缺字段），
   * 必须先窄校验，否则读 `params.sessionId` 会把 -32602 变成 -32603。
   */
  async extMethod(method: string, params: unknown): Promise<Record<string, unknown>> {
    if (method === "sangxia.set_model" || method === "_sangxia.set_model") {
      await this.setSessionModel(setModelParams(params));
      return {};
    }
    // The router passes the full wire name (`_foo`), so report it as-is.
    throw RequestError.methodNotFound(method);
  }

  /**
   * Fire `session_end` (best-effort, ≤2s total) and close every session's MCP
   * connections. Sangxia does not implement `session/close` yet, so this runs
   * once on process exit (see index.ts) rather than per session.
   */
  async shutdown(): Promise<void> {
    if (this.#idleTimer) clearInterval(this.#idleTimer);
    this.#idleTimer = null;
    const sessions = [...this.#sessions.values()];
    for (const session of sessions) session.abort?.abort();
    // Evicted sessions are still open from the client's point of view, so
    // they get their session_end too (their stub keeps the hook registry).
    const ending: Array<Pick<Session, "id" | "cwd" | "permissionMode" | "modelId" | "hooks">> = [
      ...sessions,
      ...this.#evicted.values(),
    ];
    // Hard cap: a hanging hook must never hold the process open (plan §3).
    await Promise.race([
      Promise.all(ending.map((session) => this.runSessionEnd(session))),
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

/** Narrow the raw (unvalidated) params of a legacy / extension set_model request. */
export function setModelParams(params: unknown): SetSessionModelRequest {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw RequestError.invalidParams({ params: "需要 { sessionId, modelId } 对象" });
  }
  const { sessionId, modelId } = params as Record<string, unknown>;
  if (typeof sessionId !== "string") throw RequestError.invalidParams({ sessionId: "必须是字符串" });
  if (typeof modelId !== "string") throw RequestError.invalidParams({ modelId: "必须是字符串" });
  return { sessionId, modelId };
}

/** `session_end` 的硬上限：超时放弃，绝不拖住进程退出。 */
const SESSION_END_TIMEOUT_MS = 2000;
/** Upper bound on the idle-eviction sweep period (shorter timeouts sweep at their own period). */
const IDLE_SWEEP_MAX_INTERVAL_MS = 60_000;
/** How long a replacing `session/load` waits for the old session's aborted turn (SA-12). */
const RETIRE_TURN_TIMEOUT_MS = 5000;

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
      { id: "auto", name: "Full Access", description: "自动批准常规变更；Hook 强制确认仍生效" },
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
    `- 需要运行命令(构建/测试/git 等)时用 bash 工具；它在本机实际使用 ${resolveShell().label}。${shellSyntaxHint(resolveShell())}`,
    "- 任务复杂时用 update_plan 拆解步骤并随进度更新状态。",
    "- 需要查阅网页文档/Issue 时用 fetch_url。",
    "- 需求有歧义、或继续前必须由用户在几个方案中拍板时，用 ask_user 提问，不要猜；能自己查清的不要问。",
    "- 涉及项目架构、重要决策或未完成事项时，完成任务后更新 AGENTS.md 或 .sangxia/memory.md。",
    "- 路径可用相对当前工作目录的写法。",
    "- 回答简洁，用中文。完成后简要说明做了什么。" +
    "- 最后记得喵一下。",
  ].join("\n");
}
