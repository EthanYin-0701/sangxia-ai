import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { assertKnownHookEvents, assertValidHookEntries, resolveHookCommands } from "./hooks/paths.js";
import { HOOK_EVENTS, type HookEntry } from "./hooks/types.js";
import { logger } from "./logger.js";

/**
 * Configuration loading & validation.
 *
 * Resolution order for the **primary** config:
 *   1. `--config <path>` CLI flag
 *   2. `$SANGXIA_CONFIG` env var
 *   3. `./sangxia.config.json` (cwd)
 *   4. `~/.config/sangxia/config.json`
 *
 * Layering (D16): `~/.config/sangxia/config.json` is *always* loaded as the base and
 * the primary config is merged on top of it (deep merge, primary wins; `hooks.events.*`
 * arrays are **appended** so a global hook cannot be silenced by a project config).
 * A project file alone can then keep just its own overrides — e.g. only `provider`.
 *
 * String values support `${ENV_VAR}` interpolation so secrets (API keys) can stay
 * out of the file and live in the environment instead.
 */

const providerSchema = z
  .object({
    type: z.enum(["openai", "mock"]).default("openai"),
    baseURL: z.string().url().optional(),
    apiKey: z.string().optional(),
    model: z.string().min(1).default("gpt-4o"),
    models: z
      .array(
        z.object({
          modelId: z.string().min(1),
          name: z.string().min(1),
          description: z.string().optional(),
          firstChunkTimeoutMs: z.number().int().positive().optional(),
          streamIdleTimeoutMs: z.number().int().positive().optional(),
          streamTotalTimeoutMs: z.number().int().positive().optional(),
          streamRetries: z.number().int().min(0).max(5).optional(),
          streamRetryBaseDelayMs: z.number().int().positive().optional(),
          /**
           * Per-model output budget. `max_tokens` is one shared pool for
           * reasoning + visible text + tool-call arguments, and providers count
           * it against the context window, so a reasoning model needs a much
           * larger budget than a plain chat model.
           */
          maxTokens: z.number().int().positive().optional(),
        }),
      )
      .min(1)
      .optional(),
    temperature: z.number().min(0).max(2).default(0),
    /**
     * Output budget sent as `max_tokens`. Left unset by default so the request
     * simply omits the field and the backend's own default applies — DeepSeek's
     * thinking-mode default (64K, 128K at `reasoning_effort=max`) is already
     * larger than any fixed value we'd want to hardcode here, and picking one
     * only risks truncating output the backend would otherwise have produced.
     */
    maxTokens: z.number().int().positive().optional(),
    requestTimeoutMs: z.number().int().positive().default(120_000),
    /**
     * Deadline for the wait **before the first streamed delta** — covers
     * connection setup and any server-side queueing. Kept separate from
     * `streamIdleTimeoutMs` (the gap *between* chunks once streaming has
     * started) because a busy DeepSeek endpoint sends SSE `: keep-alive`
     * comment lines while queueing, which the SDK drops without producing a
     * chunk — so under the old single idle timer, Sangxia would kill (and
     * never retry) a request the server was still going to answer. DeepSeek
     * itself only gives up after 10 minutes of no inference started, so the
     * default here matches that.
     */
    firstChunkTimeoutMs: z.number().int().positive().default(600_000),
    streamIdleTimeoutMs: z.number().int().positive().default(60_000),
    streamTotalTimeoutMs: z.number().int().positive().default(120_000),
    /**
     * Bounded retries for failures **before the first streamed delta** (network
     * blips, 429, 5xx). Once anything was streamed a retry could duplicate
     * output, so those failures still terminate the turn. The SDK's own
     * retries stay off (`maxRetries: 0`) — retry semantics belong to us.
     */
    streamRetries: z.number().int().min(0).max(5).default(2),
    streamRetryBaseDelayMs: z.number().int().positive().default(500),
    /**
     * Ask the backend for a `usage` block on the final SSE chunk. DeepSeek
     * always includes it regardless of this flag; other OpenAI-compatible
     * backends that don't support it simply ignore the request option. Default
     * on because usage (in particular `prompt_cache_hit_tokens`) is otherwise
     * invisible and cost on DeepSeek is dominated by prompt tokens.
     */
    streamIncludeUsage: z.boolean().default(true),
    /**
     * Whether captured assistant `reasoning_content` from earlier turns is
     * echoed back on subsequent requests. DeepSeek's thinking mode requires
     * this whenever `tools` are present (Sangxia always sends tools) and
     * returns 400 otherwise. "none" is an escape hatch for a backend that
     * rejects an unrecognized field instead of ignoring it.
     */
    passBackReasoning: z.enum(["all", "none"]).default("all"),
    extraHeaders: z.record(z.string()).optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.type === "openai") {
      if (!cfg.baseURL) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["baseURL"], message: "openai provider 需要 baseURL（如 https://api.openai.com/v1）" });
      }
      if (!cfg.apiKey?.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["apiKey"], message: "provider.apiKey 为空" });
      }
    }
    if (cfg.models) {
      const ids = cfg.models.map((model) => model.modelId);
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["models"], message: "模型 ID 不可重复" });
      }
      if (!ids.includes(cfg.model)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["model"], message: "默认 model 必须出现在 models 列表中" });
      }
    }
  });

/**
 * 权限确认模式：
 * - "confirm"：变更类工具（write/edit/bash/MCP 等）执行前每次请求人类确认（默认）。
 * - "auto"：bypass 所有权限确认，直接执行（适合信任的 IDE / 自动化场景，注意风险）。
 *
 * 兼容旧字段：`agent.autoApprove: true` 等价于 `permissionMode: "auto"`。
 */
const agentSchema = z
  .object({
    maxIterations: z.number().int().positive().default(120),
    historyWarningMessages: z.number().int().positive().default(400),
    /**
     * Default deadline for one tool invocation (M3). The LLM has idle/total
     * watchdogs; tools previously had no counterpart at all. A tool that
     * declares `timeoutMs` (or a call that sets `timeout`, e.g. bash) wins.
     */
    toolTimeoutMs: z.number().int().positive().default(300_000),
    permissionMode: z.enum(["confirm", "auto"]).optional(),
    /** @deprecated 用 `permissionMode: "auto"` 替代；`true` 等价于 auto。 */
    autoApprove: z.boolean().optional(),
    systemPrompt: z.string().nullable().default(null),
  })
  .transform((cfg) => ({
    maxIterations: cfg.maxIterations,
    historyWarningMessages: cfg.historyWarningMessages,
    toolTimeoutMs: cfg.toolTimeoutMs,
    permissionMode: cfg.permissionMode ?? (cfg.autoApprove === true ? "auto" : "confirm"),
    systemPrompt: cfg.systemPrompt,
  }));

/** MCP client behavior. Servers themselves arrive per-session via ACP `session/new`. */
const mcpSchema = z
  .object({
    enabled: z.boolean().default(true),
    connectTimeoutMs: z.number().int().positive().default(15_000),
  })
  .default({});

/**
 * Skill discovery. `dirs` are extra directories to scan (relative paths resolve
 * against the session cwd); an empty list means "use the built-in defaults"
 * (`<cwd>/skills` and `~/.config/sangxia/skills`).
 */
const skillsSchema = z
  .object({
    enabled: z.boolean().default(true),
    dirs: z.array(z.string()).default([]),
  })
  .default({});

/**
 * 生命周期钩子（hooks）配置 —— 见 `plan/hooks_support.md` §4。
 *
 * 默认**关闭**（升级零行为变化）。所有 hook 都是本地用户自己配置的外部命令：
 * 权限等同用户 shell，因此脚本自身不做沙箱；安全默认是"不配就不跑"。
 */
const hookEntrySchema = z.object({
  /** 日志标识，缺省用 command。 */
  name: z.string().optional(),
  /** 经 shell 执行。路径形态的命令在加载期解析成绝对路径（相对**配置文件目录**）。 */
  command: z.string().min(1),
  /** JS 正则：工具事件匹配工具名，`session_start` 匹配 `source`（startup/resume）。 */
  matcher: z.string().optional(),
  /** 覆盖全局 `hooks.timeoutMs`。 */
  timeoutMs: z.number().int().positive().optional(),
  /** 覆盖全局 `hooks.onError`。 */
  onError: z.enum(["allow", "deny"]).optional(),
});

const hooksSchema = z
  .object({
    /** 总开关，默认关闭。 */
    enabled: z.boolean().default(false),
    /** 单条 hook 默认超时。 */
    timeoutMs: z.number().int().positive().default(60_000),
    /** 超时 / 崩溃 / 输出不可解析时的全局默认："allow"（放行）或 "deny"（fail-closed）。 */
    onError: z.enum(["allow", "deny"]).default("allow"),
    /** null = 平台默认（`shell: true`）；可指定 "/bin/bash"。 */
    shell: z.string().nullable().default(null),
    /**
     * 项目级 hooks（`.sangxia/hooks.json`）默认关闭：该文件随仓库分发 = 打开仓库就
     * 执行任意命令（供应链风险）。开启后其相对路径命令以**项目根**为基准，
     * 且不能放宽 `onError` / 超时上限（只允许更严）。
     */
    projectFile: z
      .object({
        enabled: z.boolean().default(false),
        path: z.string().default(".sangxia/hooks.json"),
      })
      .default({}),
    events: z
      .object({
        session_start: z.array(hookEntrySchema).default([]),
        user_prompt_submit: z.array(hookEntrySchema).default([]),
        pre_tool_use: z.array(hookEntrySchema).default([]),
        post_tool_use: z.array(hookEntrySchema).default([]),
        turn_end: z.array(hookEntrySchema).default([]),
        session_end: z.array(hookEntrySchema).default([]),
      })
      .default({}),
  })
  .default({});

const configSchema = z.object({
  provider: providerSchema,
  agent: agentSchema.default({}),
  mcp: mcpSchema,
  skills: skillsSchema,
  hooks: hooksSchema,
});

export type ProviderConfig = z.infer<typeof providerSchema>;
export type AgentConfig = z.infer<typeof agentSchema>;
export type McpConfig = z.infer<typeof mcpSchema>;
export type SkillsConfig = z.infer<typeof skillsSchema>;
export type HooksConfig = z.infer<typeof hooksSchema>;
export type HookEntryConfig = z.infer<typeof hookEntrySchema>;
export type Config = z.infer<typeof configSchema>;

/** `loadConfig` 的返回值：配置本体 + 实际使用的配置文件路径。 */
export interface LoadedConfig extends Config {
  /** 主配置（overlay）的绝对路径；无项目配置时即全局配置。 */
  configPath: string;
  /** 主配置目录（D15 相对路径基准的兜底）。 */
  configDir: string;
  /** 分层加载的 base（`~/.config/sangxia/config.json`）；未参与则为 null。 */
  baseConfigPath: string | null;
  /** 实际参与加载的配置文件，base 在前。 */
  configPaths: string[];
}

/** Recursively replace `${VAR}` occurrences in string values with env vars. */
export function interpolateEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const v = process.env[name];
      if (v === undefined) {
        throw new Error(`配置引用了环境变量 \${${name}}，但它未设置`);
      }
      return v;
    });
  }
  if (Array.isArray(value)) return value.map(interpolateEnv);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateEnv(v)]));
  }
  return value;
}

export function resolveConfigPath(argv: string[]): string | null {
  const flagIdx = argv.indexOf("--config");
  if (flagIdx >= 0) {
    const path = argv[flagIdx + 1];
    if (!path || path.startsWith("--")) throw new Error("--config 需要文件路径");
    return resolve(path);
  }

  if (process.env.SANGXIA_CONFIG) return resolve(process.env.SANGXIA_CONFIG);

  const cwdPath = resolve(process.cwd(), "sangxia.config.json");
  if (existsSync(cwdPath)) return cwdPath;

  const homePath = join(homedir(), ".config", "sangxia", "config.json");
  if (existsSync(homePath)) return homePath;

  return null;
}

/** 权限模式的 CLI/env 覆盖：--permission-mode auto|confirm 或 SANGXIA_PERMISSION_MODE。 */
function permissionModeOverride(argv: string[]): "auto" | "confirm" | null {
  const flagIdx = argv.indexOf("--permission-mode");
  if (flagIdx >= 0) {
    const v = argv[flagIdx + 1];
    if (v === "auto" || v === "confirm") return v;
    throw new Error(`--permission-mode 取值无效: ${v}（应为 auto 或 confirm）`);
  }
  const envValue = process.env.SANGXIA_PERMISSION_MODE;
  if (envValue !== undefined) {
    if (envValue === "auto" || envValue === "confirm") return envValue;
    throw new Error(`SANGXIA_PERMISSION_MODE 取值无效: ${envValue}（应为 auto 或 confirm）`);
  }
  return null;
}

/**
 * hooks 的加载期处理（§4-6 / §10-D15 / §10-D16）：正则与取值校验，路径形态的
 * `command` 按**声明它的那份配置所在目录**解析成绝对路径并校验存在性（不存在直接
 * fail fast，否则会退化成"每次调用都失败 + `onError` 默认 allow"）。
 *
 * 分层加载后 hook 条目可能来自两份文件（全局 base + 项目 overlay），所以**按来源
 * 分别**解析路径，再按事件把数组**追加**合并（base 先、overlay 后）。
 */
interface HookSource {
  /** 声明这些条目的配置文件。 */
  path: string;
  /** 该文件的目录 —— 相对路径命令的解析基准（D15）。 */
  dir: string;
  /** 该文件原始的 `hooks.events`（未插值/未解析）。 */
  events: Record<string, unknown>;
}

const hookEntriesSchema = z.array(hookEntrySchema);

/** `~/.config/sangxia/config.json`：用户级全局配置，永远是分层加载的 base。 */
export function globalConfigPath(): string {
  return join(homedir(), ".config", "sangxia", "config.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 深合并：对象逐字段递归，标量与**数组**由 overlay 整体覆盖。
 * `hooks.events.*` 是唯一例外（追加语义，见 `applyHookSources`）。
 */
function deepMerge(base: unknown, overlay: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

function readConfigFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`读取/解析配置文件失败 (${path}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 抽出一份配置里的 `hooks.events`（不存在则返回 null）。 */
function collectHookSource(path: string, raw: unknown): HookSource | null {
  const hooks = isPlainObject(raw) ? raw.hooks : undefined;
  const events = isPlainObject(hooks) ? hooks.events : undefined;
  if (!isPlainObject(events)) return null;
  return { path, dir: dirname(path), events };
}

function parseHookEntries(raw: unknown, where: string): HookEntry[] {
  const parsed = hookEntriesSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(item)"}: ${i.message}`)
      .join("; ");
    throw new Error(`${where}: hook 配置无效 —— ${details}`);
  }
  return parsed.data as HookEntry[];
}

/**
 * 按来源合并 hook 条目并写回 `hooks.events.*`（D16）。
 *
 * 合并顺序 = 全局 base → 项目 overlay；重复的命令**都保留**（不做去重：去重会让
 * 项目配置意外"顶掉"全局 hook，而用户以为自己还开着全局那条）。
 * `hooks.enabled: false` 时条目不做任何校验 —— 未启用的段不影响加载。
 */
function applyHookSources(hooks: HooksConfig, sources: HookSource[], label: string): void {
  for (const event of HOOK_EVENTS) hooks.events[event] = [];
  if (!hooks.enabled) return;
  let count = 0;
  for (const source of sources) {
    assertKnownHookEvents(source.events, `${source.path} → hooks.events`);
    for (const event of HOOK_EVENTS) {
      const raw = source.events[event];
      if (raw === undefined || raw === null) continue;
      const where = `${source.path} → hooks.events.${event}`;
      const entries = parseHookEntries(interpolateEnv(raw), where);
      assertValidHookEntries(entries, where);
      hooks.events[event]!.push(...resolveHookCommands(entries, source.dir, where));
      count += entries.length;
    }
  }
  if (count === 0) {
    logger.warn(`hooks.enabled=true 但未配置任何事件（${label}）`);
  } else {
    logger.info(
      `hooks 已启用: ${count} 条配置级 hook · 来源=${sources.map((s) => s.path).join(" + ")} · ` +
        `timeout=${hooks.timeoutMs}ms onError=${hooks.onError} · projectFile=${hooks.projectFile.enabled ? hooks.projectFile.path : "关闭"}`,
    );
  }
}

export function loadConfig(argv: string[] = process.argv.slice(2)): LoadedConfig {
  const overlayPath = resolveConfigPath(argv);
  const globalPath = globalConfigPath();
  // 分层加载（D16）：全局配置作为 base，除非它**就是**主配置本身（此时退化为单文件）。
  const basePath =
    overlayPath !== null && resolve(overlayPath) !== resolve(globalPath) && existsSync(globalPath)
      ? globalPath
      : null;
  const primaryPath = overlayPath;
  // TODO(acpreg): 环境变量 bootstrap —— 无配置文件时尝试用 SANGXIA_BASE_URL /
  //   SANGXIA_API_KEY / SANGXIA_MODEL 组合 provider 配置，实现 headless 零配置直跑
  //   （见 plan/acpreg.md §2.3 路径 C、§3 阶段 1）。
  if (!primaryPath) {
    throw new Error(
      "未找到配置文件。请用 --config <path> 指定，或创建 ./sangxia.config.json（参考 sangxia.config.example.json），" +
        `或放一份全局配置在 ${globalPath}。`,
    );
  }

  const primaryRaw = readConfigFile(primaryPath);
  const baseRaw = basePath === null ? null : readConfigFile(basePath);
  const layered = baseRaw !== null;
  const sources: HookSource[] = [];
  if (basePath !== null) {
    const source = collectHookSource(basePath, baseRaw);
    if (source) sources.push(source);
  }
  {
    const source = collectHookSource(primaryPath, primaryRaw);
    if (source) sources.push(source);
  }
  if (layered) {
    logger.info(`配置分层: ${basePath}（全局 base） + ${primaryPath}（项目 overlay）`);
  }

  const merged = layered ? deepMerge(baseRaw, primaryRaw) : primaryRaw;
  const parsed = configSchema.safeParse(interpolateEnv(merged));
  const rawProvider = isPlainObject(merged) && isPlainObject(merged.provider) ? merged.provider : {};
  const keyRefs = typeof rawProvider.apiKey === "string"
    ? rawProvider.apiKey.match(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g) ?? [] : [];
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${
        i.path.join(".") === "provider.apiKey"
          ? `provider.apiKey 为空${keyRefs.length ? `（来源: ${keyRefs.join(", ")}）` : ""}`
          : i.message
      }`)
      .join("\n");
    const where = layered ? `${primaryPath} + ${basePath}` : primaryPath;
    throw new Error(`配置无效 (${where}):\n${details}`);
  }

  const config = parsed.data;
  // hooks：正则/取值校验 + 路径形态命令的加载期解析与存在性检查（D15）+ 分层合并（D16）。
  applyHookSources(config.hooks, sources, sources.map((s) => s.path).join(" + ") || primaryPath);
  // CLI 参数 / 环境变量可以覆盖配置文件里的权限模式（便于 IDE 侧按 agent 配置切换）。
  const override = permissionModeOverride(argv);
  if (override) config.agent.permissionMode = override;
  const configPaths = [basePath, primaryPath].filter(
    (p, i, all): p is string => p !== null && all.indexOf(p) === i,
  );
  const keySource = keyRefs.length ? `环境变量引用 ${keyRefs.join(", ")}`
    : config.provider.apiKey ? "字面量" : "未提供（mock 无需凭据）";
  logger.info(`凭据来源: ${configPaths.join(" + ")} · apiKey=${keySource}`);
  return Object.assign(config, {
    configPath: primaryPath,
    configDir: dirname(primaryPath),
    baseConfigPath: basePath,
    configPaths,
  });
}
