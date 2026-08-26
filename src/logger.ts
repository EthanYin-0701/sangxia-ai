import { appendFileSync } from "node:fs";
import { inspect } from "node:util";

/**
 * stderr-only logger.
 *
 * IMPORTANT: stdout is the ACP JSON-RPC channel. Anything written to stdout that
 * is not a valid JSON-RPC message will corrupt the protocol stream. All diagnostic
 * output MUST go to stderr (and, optionally, a file via ZHENTE_LOG_FILE).
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;

const logFile = process.env.ZHENTE_LOG_FILE;
const configuredLevel = (process.env.ZHENTE_LOG_LEVEL ?? "info").toLowerCase() as Level;
const threshold = LEVELS[configuredLevel] ?? LEVELS.info;
// Use the host's local timezone by default. Set this explicitly when the ACP
// host (for example an editor) runs with a different TZ environment.
const logTimeZone = process.env.ZHENTE_LOG_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

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

function emit(level: Level, args: unknown[]): void {
  if (LEVELS[level] > threshold) return;
  const line = `${timestamp(new Date())} [${level.toUpperCase()}] ${format(args)}\n`;
  process.stderr.write(line);
  if (logFile) {
    try {
      appendFileSync(logFile, line);
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
};
