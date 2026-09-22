import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { globalConfigPath } from "./config.js";

export const SETUP_HELP = `Usage: sangxia setup [options]
  --provider openai|mock    Provider (default: openai)
  --base-url URL            OpenAI-compatible URL (default: https://api.openai.com/v1)
  --model NAME              Model (default: gpt-4o)
  --api-key-env NAME        Store an environment reference; NAME must be set during setup
  --api-key KEY             Store a literal key (visible in process listings / shell history)
  --non-interactive         Never prompt (also implied when stdin is not a TTY)
  --skip-verify             Save without testing provider connectivity
  --config PATH            Startup overlay; setup still writes the global config
  --help, -h               Show this help
`;

function parseArgs(argv: string[]): Map<string, string | true> {
  const values = new Set(["--provider", "--base-url", "--model", "--api-key-env", "--api-key", "--config"]);
  const flags = new Set(["--non-interactive", "--skip-verify", "--help", "-h"]);
  const options = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (options.has(flag)) throw new Error(`重复参数: ${flag}`);
    if (flags.has(flag)) options.set(flag, true);
    else if (values.has(flag)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} 需要参数值`);
      options.set(flag, value);
    } else throw new Error("未知 setup 参数；运行 sangxia setup --help 查看用法");
  }
  if (options.has("--api-key") && options.has("--api-key-env")) {
    throw new Error("--api-key 与 --api-key-env 不能同时使用");
  }
  return options;
}

/** readline keeps normal editing, while its output sink suppresses secret echo. */
function createPrompter() {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stderr.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  let closed = false;
  rl.once("close", () => { closed = true; });
  return {
    async ask(label: string, fallback = "", secret = false): Promise<string> {
      if (closed) throw new Error("配置已取消");
      process.stderr.write(`${label}${fallback ? ` [${fallback}]` : ""}: `);
      muted = secret;
      try {
        const answer = await new Promise<string>((resolve, reject) => {
          const cleanup = () => { rl.off("close", cancel); rl.off("SIGINT", cancel); };
          const cancel = () => { cleanup(); reject(new Error("配置已取消")); };
          rl.once("close", cancel);
          rl.once("SIGINT", cancel);
          rl.question("", (value) => { cleanup(); resolve(value); });
        });
        return answer.trim() || fallback;
      } finally {
        muted = false;
        if (secret) process.stderr.write("\n");
      }
    },
    close() { rl.close(); },
  };
}

async function verifyProvider(baseURL: string, apiKey: string, model: string): Promise<void> {
  const base = baseURL.replace(/\/+$/, "");
  const signal = AbortSignal.timeout(15_000);
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  try {
    let response = await fetch(`${base}/models`, { headers, signal, redirect: "error" });
    await response.body?.cancel();
    if (response.status === 404 || response.status === 405) {
      response = await fetch(`${base}/chat/completions`, {
        method: "POST", headers, signal, redirect: "error",
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Hi" }], max_tokens: 1, stream: false }),
      });
      await response.body?.cancel();
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (e) {
    // Never print response bodies, URLs with credentials, or request headers.
    const status = e instanceof Error && /^HTTP \d+$/.test(e.message) ? e.message : "网络错误或超时";
    throw new Error(`连通性验证失败（${status}）；旧配置未改动。可检查配置后重试，或使用 --skip-verify。`);
  }
}

async function writeConfig(path: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
      await file.chmod(0o600);
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function runSetup(argv: string[]): Promise<number> {
  let prompter: ReturnType<typeof createPrompter> | undefined;
  try {
    const options = parseArgs(argv);
    if (options.has("--help") || options.has("-h")) {
      process.stderr.write(SETUP_HELP);
      return 0;
    }
    const value = (flag: string): string | undefined => {
      const result = options.get(flag);
      return typeof result === "string" ? result : undefined;
    };
    const path = globalConfigPath();
    let existing: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const raw: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
        existing = raw as Record<string, unknown>;
      } catch {
        throw new Error(`全局配置不是有效 JSON 对象，未覆盖: ${path}`);
      }
    }
    if (process.stdin.isTTY && !options.has("--non-interactive")) prompter = createPrompter();
    const provider = value("--provider") ?? (await prompter?.ask("Provider (openai/mock)", "openai")) ?? "openai";
    if (provider !== "openai" && provider !== "mock") throw new Error("provider 必须是 openai 或 mock");
    const baseURL = value("--base-url") ?? (provider === "openai"
      ? (await prompter?.ask("Base URL", "https://api.openai.com/v1")) ?? "https://api.openai.com/v1" : undefined);
    if (baseURL !== undefined) {
      let url: URL;
      try { url = new URL(baseURL); } catch { throw new Error("baseURL 必须是有效的 HTTP(S) URL"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error("baseURL 必须是无凭据、查询参数和片段的 HTTP(S) URL");
      }
    }
    const model = value("--model") ?? (await prompter?.ask("Model", "gpt-4o")) ?? "gpt-4o";
    if (!model.trim()) throw new Error("model 不能为空");
    const envName = value("--api-key-env");
    if (envName !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
      throw new Error("--api-key-env 必须是有效的环境变量名称");
    }
    const apiKey = envName !== undefined ? process.env[envName]
      : value("--api-key") ?? (provider === "openai" ? await prompter?.ask("API key（不回显）", "", true) : undefined);
    if (provider === "openai" && !apiKey?.trim()) {
      throw new Error(envName ? `环境变量 ${envName} 为空或未设置` : "需要 --api-key-env NAME 或 --api-key KEY");
    }
    prompter?.close();
    if (provider === "openai" && !options.has("--skip-verify")) {
      process.stderr.write("正在验证 provider 连通性…\n");
      await verifyProvider(baseURL!, apiKey!, model);
    }
    const storedKey = envName !== undefined ? `\${${envName}}` : apiKey;
    await writeConfig(path, {
      ...existing,
      provider: { type: provider, ...(baseURL ? { baseURL } : {}), model, ...(storedKey !== undefined ? { apiKey: storedKey } : {}) },
    });
    process.stderr.write(`配置已保存: ${path}（权限 0600）\n`);
    if (options.has("--skip-verify")) process.stderr.write("已按 --skip-verify 跳过连通性验证。\n");
    if (envName) process.stderr.write(`启动 agent 时仍需提供环境变量 ${envName}（可由 ACP 客户端 env 注入）。\n`);
    process.stderr.write("若当前目录有 sangxia.config.json，或设置了 SANGXIA_CONFIG / --config，它们会作为 overlay 合并并覆盖全局配置。\n请重新连接 ACP 客户端。\n");
    return 0;
  } catch (e) {
    process.stderr.write(`setup 失败: ${e instanceof Error ? e.message : "未知错误"}\n`);
    return 1;
  } finally { prompter?.close(); }
}
