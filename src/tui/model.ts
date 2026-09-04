/**
 * Chat model (model.ts): maps ACP session notifications to renderable chat
 * entries. Pure state machine, no I/O — shared by the TUI and the smoke test,
 * and unit-testable without a terminal.
 */

import type {
  PlanEntry,
  SessionNotification,
} from "@zed-industries/agent-client-protocol";
import { helpLines } from "./commands.js";
import { fmtTime, type ChatEntry, type ChatEntryTool } from "./ui.js";

export type ToolRowEntry = ChatEntryTool;

export interface StreamingState {
  text: string;
  thinking: string | null; // last thought line while streaming
}

/** Parse an ACP content block into plain text (text-only blocks). */
export function contentToText(content: unknown): string {
  if (content && typeof content === "object") {
    const c = content as { type?: string; text?: string; content?: unknown };
    if (c.type === "text" && typeof c.text === "string") return c.text;
    if (c.type === "content") {
      const inner = c.content as { type?: string; text?: string } | undefined;
      if (inner?.type === "text" && typeof inner.text === "string") return inner.text;
    }
  }
  return "";
}

export class ChatModel {
  entries: ChatEntry[] = [];
  streaming: StreamingState | null = null;
  /** Index in `entries` of the current plan block (-1 = none). */
  #planIndex = -1;

  resetForNewSession(): void {
    this.entries = [];
    this.streaming = null;
    this.#planIndex = -1;
  }

  addUser(text: string, time = fmtTime()): void {
    this.entries.push({ kind: "user", text, time });
  }

  addAssistant(text: string, time = fmtTime()): void {
    this.entries.push({ kind: "assistant", text, time });
  }

  addNotice(text: string, danger?: boolean): void {
    this.entries.push({ kind: "notice", text, danger });
  }

  addMeta(text: string): void {
    this.entries.push({ kind: "meta", text });
  }

  addHelp(): void {
    this.entries.push({ kind: "help", lines: helpLines() });
  }

  clearScreen(): void {
    this.entries = [];
    this.streaming = null;
    this.#planIndex = -1;
  }

  /** Apply one ACP session notification; returns true if state changed. */
  applyUpdate(n: SessionNotification): boolean {
    const u = n.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const text = contentToText(u.content);
        if (!this.streaming) this.streaming = { text: "", thinking: null };
        this.streaming.text += text;
        return text.length > 0;
      }
      case "agent_thought_chunk": {
        const text = contentToText(u.content);
        if (!this.streaming) this.streaming = { text: "", thinking: null };
        this.streaming.thinking = text || this.streaming.thinking;
        return true;
      }
      case "tool_call": {
        const st = u.status ?? "in_progress";
        const existing = this.#toolRow(u.toolCallId);
        if (existing) {
          existing.title = u.title ?? existing.title;
          existing.status = st === "failed" ? "failed" : st === "completed" ? "completed" : "in_progress";
          if (existing.status !== "in_progress") existing.finishedAt = fmtTime();
        } else {
          const now = new Date();
          const kind = u.kind ?? "other";
          this.entries.push({
            kind: "tool",
            id: u.toolCallId,
            title: u.title,
            danger: kind === "edit" || kind === "delete" || u.title.includes("bash"),
            status: st === "failed" ? "failed" : st === "completed" ? "completed" : "in_progress",
            startedAt: Date.now(),
            finishedAt: st === "failed" || st === "completed" ? fmtTime(now) : undefined,
            detail: this.#detailOf(u.rawInput),
            expanded: false,
          } satisfies ToolRowEntry);
        }
        return true;
      }
      case "tool_call_update": {
        const row = this.#toolRow(u.toolCallId);
        if (!row) return false; // update for a tool we never announced — ignore
        if (u.status === "completed" || u.status === "failed") {
          row.status = u.status;
          row.finishedAt = fmtTime();
        }
        if (u.title) row.title = u.title;
        if (u.rawInput) row.detail = this.#detailOf(u.rawInput);
        if (u.content && u.content.length > 0) {
          const parts = u.content.map((c) => contentToText(c)).filter(Boolean);
          if (parts.length > 0) row.output = parts.join("\n");
        }
        return true;
      }
      case "plan": {
        const block: ChatEntry = {
          kind: "plan",
          entries: (u.entries as PlanEntry[]).map((e) => ({
            content: e.content,
            status: e.status,
            priority: e.priority,
          })),
        };
        if (this.#planIndex >= 0 && this.#planIndex < this.entries.length) {
          this.entries[this.#planIndex] = block;
        } else {
          this.#planIndex = this.entries.length;
          this.entries.push(block);
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** Finalize the streaming block into a stored assistant entry. */
  finalizeStream(): void {
    const s = this.streaming;
    this.streaming = null;
    if (s) {
      if (s.text.trim() === "") {
        if (s.thinking) this.addMeta(`（${s.thinking}）`);
        else this.addMeta("（无可见输出）");
      } else {
        this.addAssistant(s.text);
      }
    }
  }

  toolRows(): ToolRowEntry[] {
    return this.entries.filter((e): e is ToolRowEntry => e.kind === "tool");
  }

  #toolRow(id: string): ToolRowEntry | undefined {
    return this.toolRows().find((r) => r.id === id);
  }

  #detailOf(rawInput: unknown): string | undefined {
    if (rawInput && typeof rawInput === "object") {
      const cmd = (rawInput as Record<string, unknown>).command;
      if (typeof cmd === "string") {
        const lines = cmd.split("\n");
        return lines.length > 1 ? `${lines[0]} …(+${lines.length - 1}行)` : cmd;
      }
      const path = (rawInput as Record<string, unknown>).path;
      if (typeof path === "string") return path;
    }
    return undefined;
  }
}
