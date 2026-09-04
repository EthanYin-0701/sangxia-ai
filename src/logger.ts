import { appendFileSync, mkdirSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { inspect } from "node:util";

/**
 * stderr-only logger.
 *
 * IMPORTANT: stdout is the ACP JSON-RPC channel. Anything written to stdout that
 * is not a valid JSON-RPC message will corrupt the protocol stream. All diagnostic
 * output MUST go to stderr (and, optionally, to files via the env vars below).
 *
 * Log file modes (both optional, never required):
 * - `ZHENTE_LOG_DIR=<dir>`: per-session mode. Each session writes to
 *   `<dir>/<sessionId>.log`; lines logged without a bound session (startup,
 *   initialize, …) go to `<dir>/global.log`. Sessions are bound via
 *   {@link logger.withSession}, which the agent wraps its newSession/loadSession/
 *   prompt/cancel handlers in. When both ZHENTE_LOG_DIR and ZHENTE_LOG_FILE are
 *   set, ZHENTE_LOG_DIR wins.
 * - `ZHENTE_LOG_FILE=<path>` (legacy): every line goes to one fixed file.
 *
 * Other env vars: ZHENTE_LOG_LEVEL (error|warn|info|debug, default info),
 * ZHENTE_LOG_TIMEZONE (IANA name, default host local timezone).
 *
 * Concurrency: session binding uses AsyncLocalStorage, so every log call inside
 * one async chain (prompt → runTurn → LLM stream → tool execution) resolves to
 * the session that started it — even when multiple sessions run turns
 * interleaved, lines never land in the wrong session file.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;

const logFile = process.env.ZHENTE_LOG_FILE;
const logDir = process.env.ZHENTE_LOG_DIR;
if (logDir) {
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    /* logging must never crash the agent */
  }
}

const configuredLevel = (process.env.ZHENTE_LOG_LEVEL ?? "info").toLowerCase() as Level;
const threshold = LEVELS[configuredLevel] ?? LEVELS.info;
// Use the host's local timezone by default. Set this explicitly when the ACP
// host (for example an editor) runs with a different TZ environment.
const logTimeZone = process.env.ZHENTE_LOG_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

// sessionId 来自 randomUUID（安全）或 loadSession 的客户端参数（可能任意），
// 写文件前必须过白名单校验，防止路径注入。
const SESSION_ID_RE = /^[a-zA-Z0-9-]+$/;
const GLOBAL_LOG_NAME = "global";

/**
 * 每个异步执行链的 session 归属。withSession(id, fn) 用 als.run 包裹 fn，
 * fn 及其所有 await 后代（LLM 流式、工具执行等）里的日志都能拿到自己的
 * sessionId —— 多 session 并发交错执行时也不会串文件。
 */
const sessionStore = new AsyncLocalStorage<string | undefined>();

function safeSessionId(id: string | undefined): string | undefined {
  return id && SESSION_ID_RE.test(id) ? id : undefined;
}

function timestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: logTimeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  // `longOffset` produces e.g. `GMT+08:00`; ISO-8601 uses `+08:00`.
  const offset = (values.timeZoneName ?? "GMT").replace(/^GMT/, "") || "+00:00";
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}.${values.fractionalSecond}${offset}`;
}

function format(args: unknown[]): string {
  return args
    .map((a) => (typeof a === "string" ? a : inspect(a, { depth: 4, colors: false })))
    .join(" ");
}

function currentLogPath(): string | undefined {
  if (logDir) {
    const name = sessionStore.getStore() ?? GLOBAL_LOG_NAME;
    return join(logDir, `${name}.log`);
  }
  return logFile;
}

function emit(level: Level, args: unknown[]): void {
  if (LEVELS[level] > threshold) return;
  const sessionId = sessionStore.getStore();
  const sessionTag = sessionId ? ` [session=${sessionId}]` : "";
  const line = `${timestamp(new Date())} [${level.toUpperCase()}]${sessionTag} ${format(args)}\n`;
  process.stderr.write(line);
  const file = currentLogPath();
  if (file) {
    try {
      appendFileSync(file, line);
    } catch {
      /* never let logging crash the agent */
    }
  }
}

export const logger = {
  error: (...args: unknown[]) => emit("error", args),
  warn: (...args: unknown[]) => emit("warn", args),
  info: (...args: unknown[]) => emit("info", args),
  debug: (...args: unknown[]) => emit("debug", args),
  /**
   * 把 fn（及其所有异步后代）的日志绑定到指定 session，写入 ZHENTE_LOG_DIR 下的
   * <sessionId>.log。传 undefined 或非法 sessionId 时回退为全局日志（global.log）。
   * agent 在 newSession / loadSession / prompt / cancel 的处理器外层包裹本方法。
   */
  withSession: <T>(sessionId: string | undefined, fn: () => T): T =>
    sessionStore.run(safeSessionId(sessionId), fn),
};
