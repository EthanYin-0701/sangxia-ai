import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

/**
 * Configuration loading & validation.
 *
 * Resolution order:
 *   1. `--config <path>` CLI flag
 *   2. `$ZHENTE_CONFIG` env var
 *   3. `./zhente.config.json` (cwd)
 *   4. `~/.config/zhente/config.json`
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
    maxTokens: z.number().int().positive().default(8192),
    requestTimeoutMs: z.number().int().positive().default(120_000),
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
    streamIncludeUsage: z.boolean().default(false),
    extraHeaders: z.record(z.string()).optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.type === "openai") {
      if (!cfg.baseURL) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["baseURL"], message: "openai provider 需要 baseURL（如 https://api.openai.com/v1）" });
      }
      if (!cfg.apiKey) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["apiKey"], message: "openai provider 需要 apiKey（可用 \"${OPENAI_API_KEY}\" 从环境变量注入）" });
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
    maxIterations: z.number().int().positive().default(40),
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
 * (`<cwd>/skills` and `~/.config/zhente/skills`).
 */
const skillsSchema = z
  .object({
    enabled: z.boolean().default(true),
    dirs: z.array(z.string()).default([]),
  })
  .default({});

const configSchema = z.object({
  provider: providerSchema,
  agent: agentSchema.default({}),
  mcp: mcpSchema,
  skills: skillsSchema,
});

export type ProviderConfig = z.infer<typeof providerSchema>;
export type AgentConfig = z.infer<typeof agentSchema>;
export type McpConfig = z.infer<typeof mcpSchema>;
export type SkillsConfig = z.infer<typeof skillsSchema>;
export type Config = z.infer<typeof configSchema>;

/** Recursively replace `${VAR}` occurrences in string values with env vars. */
function interpolateEnv(value: unknown): unknown {
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
  if (flagIdx >= 0 && argv[flagIdx + 1]) return resolve(argv[flagIdx + 1]!);

  if (process.env.ZHENTE_CONFIG) return resolve(process.env.ZHENTE_CONFIG);

  const cwdPath = resolve(process.cwd(), "zhente.config.json");
  if (existsSync(cwdPath)) return cwdPath;

  const homePath = join(homedir(), ".config", "zhente", "config.json");
  if (existsSync(homePath)) return homePath;

  return null;
}

/** 权限模式的 CLI/env 覆盖：--permission-mode auto|confirm 或 ZHENTE_PERMISSION_MODE。 */
function permissionModeOverride(argv: string[]): "auto" | "confirm" | null {
  const flagIdx = argv.indexOf("--permission-mode");
  if (flagIdx >= 0) {
    const v = argv[flagIdx + 1];
    if (v === "auto" || v === "confirm") return v;
    throw new Error(`--permission-mode 取值无效: ${v}（应为 auto 或 confirm）`);
  }
  const envValue = process.env.ZHENTE_PERMISSION_MODE;
  if (envValue !== undefined) {
    if (envValue === "auto" || envValue === "confirm") return envValue;
    throw new Error(`ZHENTE_PERMISSION_MODE 取值无效: ${envValue}（应为 auto 或 confirm）`);
  }
  return null;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  const path = resolveConfigPath(argv);
  // TODO(acpreg): 环境变量 bootstrap —— 无配置文件时尝试用 ZHENTE_BASE_URL /
  //   ZHENTE_API_KEY / ZHENTE_MODEL 组合 provider 配置，实现 headless 零配置直跑
  //   （见 plan/acpreg.md §2.3 路径 C、§3 阶段 1）。
  if (!path) {
    throw new Error(
      "未找到配置文件。请用 --config <path> 指定，或创建 ./zhente.config.json（参考 zhente.config.example.json）。",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`读取/解析配置文件失败 (${path}): ${e instanceof Error ? e.message : String(e)}`);
  }

  const interpolated = interpolateEnv(raw);
  const parsed = configSchema.safeParse(interpolated);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`配置无效 (${path}):\n${details}`);
  }

  const config = parsed.data;
  // CLI 参数 / 环境变量可以覆盖配置文件里的权限模式（便于 IDE 侧按 agent 配置切换）。
  const override = permissionModeOverride(argv);
  if (override) config.agent.permissionMode = override;
  return config;
}
