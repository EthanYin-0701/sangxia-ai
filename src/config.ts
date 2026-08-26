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
    temperature: z.number().min(0).max(2).default(0),
    maxTokens: z.number().int().positive().default(8192),
    requestTimeoutMs: z.number().int().positive().default(120_000),
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
  });

const agentSchema = z.object({
  maxIterations: z.number().int().positive().default(40),
  autoApprove: z.boolean().default(false),
  systemPrompt: z.string().nullable().default(null),
});

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

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  const path = resolveConfigPath(argv);
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
  return parsed.data;
}
