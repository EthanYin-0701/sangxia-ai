import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "./llm/types.js";
import { logger } from "./logger.js";
import type { PermissionMode, Session } from "./session.js";

export interface PersistedSession {
  version: 1;
  sessionId: string;
  cwd: string;
  messages: ChatMessage[];
  /** Optional for backward compatibility with sessions saved before ACP modes. */
  permissionMode?: PermissionMode;
  /** Optional for backward compatibility with sessions saved before model selection. */
  modelId?: string;
  updatedAt: string;
}

function sessionDir(): string {
  return process.env.ZHENTE_SESSION_DIR ?? join(homedir(), ".config", "zhente", "sessions");
}

function sessionPath(sessionId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error(`非法 session ID: ${sessionId}`);
  return join(sessionDir(), `${sessionId}.json`);
}

export async function saveSession(data: PersistedSession): Promise<void> {
  const path = sessionPath(data.sessionId);
  await mkdir(sessionDir(), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export async function loadSession(sessionId: string): Promise<PersistedSession | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(sessionPath(sessionId), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Partial<PersistedSession>;
    if (value.version !== 1 || value.sessionId !== sessionId || !Array.isArray(value.messages)) return null;
    return value as PersistedSession;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw e;
  }
}

/**
 * The one place a session is written to disk (M2: a single serialization exit).
 *
 * Both the agent (session create / mode / model changes) and the harness
 * (mid-turn checkpoints) go through here, so every write carries the full field
 * set. Previously the harness had its own copy without `modelId`, which meant a
 * mid-turn checkpoint silently reverted a restored session's model to the
 * config default.
 *
 * `Pick<...>` rather than the concrete class keeps the signature stable when the
 * storage format changes (see the JSONL work in step 9) and avoids a runtime
 * import cycle (type-only imports are erased at compile time).
 */
export async function persistSession(
  session: Pick<Session, "id" | "cwd" | "messages" | "permissionMode" | "modelId">,
): Promise<void> {
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
