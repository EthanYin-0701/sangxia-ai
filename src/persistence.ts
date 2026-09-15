import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "./llm/types.js";
import { logger } from "./logger.js";
import type { PermissionMode, Session } from "./session.js";

/**
 * Session persistence — append-only JSONL event log (one file per session).
 *
 * Why not a single rewritten snapshot: a long session with a snapshot format has
 * O(n²) write amplification, and it cannot record *when* a tool started, which
 * is exactly the evidence needed to decide whether an interrupted tool call may
 * be retried (see `sanitizeHistory`). An event log gives both for free:
 *
 *   {"t":"meta", ...}                      ← first line, session header
 *   {"t":"message","message":{...}}        ← history, in order
 *   {"t":"tool_started","toolCallId":...}  ← written *before* tool.run
 *   {"t":"tool_finished","toolCallId":...,"status":"completed"|"failed"}
 *   {"t":"reset","messages":[...]}         ← history was repaired/replaced
 *   {"t":"mode","permissionMode":...} / {"t":"model","modelId":...}
 *
 * The session id is validated against a whitelist before it is used in a path.
 */

export interface SessionMeta {
  version: 2;
  sessionId: string;
  cwd: string;
  permissionMode?: PermissionMode;
  modelId?: string;
  createdAt: string;
}

export type SessionEvent =
  | ({ t: "meta" } & SessionMeta)
  | { t: "message"; message: ChatMessage }
  | { t: "reset"; messages: ChatMessage[] }
  | { t: "tool_started"; toolCallId: string; name: string; at: string }
  | { t: "tool_finished"; toolCallId: string; status: "completed" | "failed"; at: string }
  | { t: "mode"; permissionMode: PermissionMode }
  | { t: "model"; modelId: string };

/** A session as read back from disk. */
export interface PersistedSession {
  version: 2;
  sessionId: string;
  cwd: string;
  messages: ChatMessage[];
  /** Optional for backward compatibility with sessions saved before ACP modes. */
  permissionMode?: PermissionMode;
  /** Optional for backward compatibility with sessions saved before model selection. */
  modelId?: string;
  /**
   * Every tool call id that ever got a `tool_started` event. Used by
   * `sanitizeHistory` to tell "may have run" apart from "never ran".
   */
  startedToolCalls: Set<string>;
  updatedAt: string;
}

function sessionDir(): string {
  return process.env.ZHENTE_SESSION_DIR ?? join(homedir(), ".config", "zhente", "sessions");
}

/** `<sessionDir>/<sessionId>.jsonl`。会话 ID 来自客户端时必须先过白名单。 */
export function sessionPath(sessionId: string, ext: "jsonl" | "json" = "jsonl"): string {
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error(`非法 session ID: ${sessionId}`);
  return join(sessionDir(), `${sessionId}.${ext}`);
}

/** Append one event line. Every write is an append; nothing rewrites the file. */
export async function appendEvent(sessionId: string, event: SessionEvent): Promise<void> {
  const path = sessionPath(sessionId);
  await ensureDir();
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

let dirReady = false;
async function ensureDir(): Promise<void> {
  if (dirReady) return;
  await mkdir(sessionDir(), { recursive: true });
  dirReady = true;
}

/** What we already wrote for a session, so `persistSession` can append deltas. */
interface TrackedState {
  messagesWritten: number;
  metaWritten: boolean;
  permissionMode?: PermissionMode;
  modelId?: string;
}
const tracked = new Map<string, TrackedState>();

/**
 * Sync a session to disk (the single write entry for session state).
 *
 * Implemented as an append-delta: only messages not yet written and only
 * mode/model changes are appended. Callers keep the "dump current state" call
 * shape; the storage layer figures out the delta.
 */
export async function persistSession(
  session: Pick<Session, "id" | "cwd" | "messages" | "permissionMode" | "modelId">,
): Promise<void> {
  try {
    const state = await ensureTracked(session);
    await ensureMeta(session, state);
    // The history may have been repaired (sanitizeHistory) between calls, so
    // treat "not a pure append" as a reset rather than guessing.
    if (session.messages.length < state.messagesWritten) {
      await appendEvent(session.id, { t: "reset", messages: session.messages });
      state.messagesWritten = session.messages.length;
    } else if (session.messages.length > state.messagesWritten) {
      for (const message of session.messages.slice(state.messagesWritten)) {
        await appendEvent(session.id, { t: "message", message });
      }
      state.messagesWritten = session.messages.length;
    }
    if (state.permissionMode !== session.permissionMode) {
      state.permissionMode = session.permissionMode;
      await appendEvent(session.id, { t: "mode", permissionMode: session.permissionMode });
    }
    if (state.modelId !== session.modelId) {
      state.modelId = session.modelId;
      await appendEvent(session.id, { t: "model", modelId: session.modelId });
    }
  } catch (e) {
    logger.warn(`session ${session.id} 持久化失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Record that a history was replaced in place (e.g. `sanitizeHistory` repaired
 * an interrupted turn). The loader applies it as a full history replacement.
 */
export async function persistHistoryReset(
  session: Pick<Session, "id" | "cwd" | "messages" | "permissionMode" | "modelId">,
): Promise<void> {
  try {
    const state = await ensureTracked(session);
    await ensureMeta(session, state);
    state.messagesWritten = session.messages.length;
    await appendEvent(session.id, { t: "reset", messages: session.messages });
  } catch (e) {
    logger.warn(`session ${session.id} 历史重置持久化失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Load (or adopt from disk) the per-session write bookkeeping. */
async function ensureTracked(
  session: Pick<Session, "id" | "messages" | "permissionMode" | "modelId">,
): Promise<TrackedState> {
  let state = tracked.get(session.id);
  if (state) return state;
  // First write in this process: adopt whatever is already on disk so we don't
  // re-append a history a previous run persisted.
  const existing = await readMessageCount(session.id);
  state = {
    messagesWritten: existing ?? 0,
    metaWritten: existing !== null,
    permissionMode: session.permissionMode,
    modelId: session.modelId,
  };
  tracked.set(session.id, state);
  return state;
}

async function ensureMeta(
  session: Pick<Session, "id" | "cwd" | "permissionMode" | "modelId">,
  state: TrackedState,
): Promise<void> {
  if (state.metaWritten) return;
  state.metaWritten = true;
  await appendEvent(session.id, {
    t: "meta",
    version: 2,
    sessionId: session.id,
    cwd: session.cwd,
    permissionMode: session.permissionMode,
    modelId: session.modelId,
    createdAt: new Date().toISOString(),
  });
}

/** Record that a tool call actually started (written before `tool.run`). */
export async function persistToolEvent(
  sessionId: string,
  event: { t: "tool_started"; toolCallId: string; name: string } | { t: "tool_finished"; toolCallId: string; status: "completed" | "failed" },
): Promise<void> {
  try {
    await appendEvent(sessionId, { ...event, at: new Date().toISOString() } as SessionEvent);
  } catch (e) {
    logger.warn(`session ${sessionId} 工具事件持久化失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** How many messages a session already has on disk (null when it has no file). */
async function readMessageCount(sessionId: string): Promise<number | null> {
  const text = await readIfExists(sessionPath(sessionId));
  if (text === null) return null;
  return (await parseJsonl(sessionId, text))?.messages.length ?? 0;
}

export async function loadSession(sessionId: string): Promise<PersistedSession | null> {
  const text = await readIfExists(sessionPath(sessionId));
  if (text !== null) return parseJsonl(sessionId, text);
  // Backward compatibility: migrate a pre-JSONL snapshot on first read.
  return migrateLegacySession(sessionId);
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Parse the event log.
 *
 * A truncated final line is expected after a crash (the file is append-only and
 * a half-written line can only ever be last), so it is silently dropped. A
 * malformed line in the middle is logged and skipped. A file with no usable
 * event at all yields `null`.
 */
async function parseJsonl(sessionId: string, text: string): Promise<PersistedSession | null> {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  let messages: ChatMessage[] = [];
  let meta: (SessionEvent & { t: "meta" }) | null = null;
  let permissionMode: PermissionMode | undefined;
  let modelId: string | undefined;
  let updatedAt: string | undefined;
  const startedToolCalls = new Set<string>();
  let usable = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let event: SessionEvent;
    try {
      event = JSON.parse(line) as SessionEvent;
    } catch {
      if (i === lines.length - 1) {
        logger.warn(`session ${sessionId} 事件日志末尾有未写完的行，已忽略（崩溃残留）`);
      } else {
        logger.warn(`session ${sessionId} 事件日志第 ${i + 1} 行损坏，已跳过`);
      }
      continue;
    }
    if (!event || typeof event !== "object" || typeof (event as { t?: unknown }).t !== "string") {
      logger.warn(`session ${sessionId} 事件日志第 ${i + 1} 行不是已知事件，已跳过`);
      continue;
    }
    usable++;
    switch (event.t) {
      case "meta":
        meta = event;
        permissionMode = event.permissionMode ?? permissionMode;
        modelId = event.modelId ?? modelId;
        updatedAt = event.createdAt;
        break;
      case "message":
        messages.push(event.message);
        break;
      case "reset":
        messages = [...event.messages];
        break;
      case "tool_started":
        // Kept even after `tool_finished`: repair only consults ids that have no
        // result, and "it started" stays true forever.
        startedToolCalls.add(event.toolCallId);
        updatedAt = event.at;
        break;
      case "tool_finished":
        updatedAt = event.at;
        break;
      case "mode":
        permissionMode = event.permissionMode;
        break;
      case "model":
        modelId = event.modelId;
        break;
    }
  }

  if (usable === 0) return null;
  return {
    version: 2,
    sessionId,
    cwd: meta?.cwd ?? "",
    messages,
    permissionMode,
    modelId,
    startedToolCalls,
    updatedAt: updatedAt ?? new Date().toISOString(),
  };
}

interface LegacySession {
  version: 1;
  sessionId: string;
  cwd: string;
  messages: ChatMessage[];
  permissionMode?: PermissionMode;
  modelId?: string;
  updatedAt: string;
}

/** Read a pre-JSONL `<id>.json` snapshot, convert it to JSONL, drop the old file. */
async function migrateLegacySession(sessionId: string): Promise<PersistedSession | null> {
  const text = await readIfExists(sessionPath(sessionId, "json"));
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    logger.warn(`session ${sessionId} 旧格式文件无法解析，忽略`);
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Partial<LegacySession>;
  if (value.version !== 1 || value.sessionId !== sessionId || !Array.isArray(value.messages)) return null;

  const migrated: PersistedSession = {
    version: 2,
    sessionId,
    cwd: value.cwd ?? "",
    messages: value.messages,
    permissionMode: value.permissionMode,
    modelId: value.modelId,
    startedToolCalls: new Set<string>(),
    updatedAt: value.updatedAt ?? new Date().toISOString(),
  };
  try {
    await appendEvent(sessionId, {
      t: "meta",
      version: 2,
      sessionId,
      cwd: migrated.cwd,
      permissionMode: migrated.permissionMode,
      modelId: migrated.modelId,
      createdAt: migrated.updatedAt,
    });
    for (const message of migrated.messages) {
      await appendEvent(sessionId, { t: "message", message });
    }
    tracked.set(sessionId, {
      messagesWritten: migrated.messages.length,
      metaWritten: true,
      permissionMode: migrated.permissionMode,
      modelId: migrated.modelId,
    });
    // Only JSONL is written from now on.
    await rm(sessionPath(sessionId, "json"), { force: true });
    logger.info(`session ${sessionId} 已从 JSON 快照迁移到 JSONL 事件日志（${migrated.messages.length} 条消息）`);
  } catch (e) {
    logger.warn(`session ${sessionId} 迁移失败，将使用内存状态继续: ${e instanceof Error ? e.message : String(e)}`);
  }
  return migrated;
}

/** Test/diagnostic helper: forget per-process write bookkeeping. */
export function resetPersistenceTracking(): void {
  tracked.clear();
  dirReady = false;
}
