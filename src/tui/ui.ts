/**
 * Full-screen renderer for the alternate screen (ui.ts).
 *
 * Draws status bar / banner / chat region / modal dialogs / input row into
 * physical rows, repainting only rows whose content changed (dirty-row
 * diffing). All visible symbols are ASCII (§12 B9 of plan/tui_support.md);
 * colors come from theme.ts and are never the sole information channel.
 *
 * The caller (tui/index.ts) owns the application state and hands us an
 * immutable `Frame` snapshot; this module is otherwise stateless.
 */

import { paint, type Theme, colors as C } from "./theme.js";
import { stringWidth, truncateWidth } from "./wcwidth.js";

export type ModeId = "confirm" | "auto";

export interface ChatEntryUser { kind: "user"; text: string; time?: string }
export interface ChatEntryAssistant { kind: "assistant"; text: string; time?: string }
export interface ChatEntryThought { kind: "thought"; text: string }
export interface ChatEntryMeta { kind: "meta"; text: string }
export interface ChatEntryNotice { kind: "notice"; text: string; danger?: boolean }
export interface ChatEntryTool {
  kind: "tool";
  id: string;
  title: string;
  danger: boolean;
  status: "in_progress" | "completed" | "failed";
  /** Epoch ms when the tool started (drives elapsed/spinner math). */
  startedAt: number;
  /** Display time (HH:MM:SS) when the tool finished. */
  finishedAt?: string;
  detail?: string;
  expanded: boolean;
  output?: string;
}
export interface ChatEntryPlan {
  kind: "plan";
  entries: { content: string; status: "pending" | "in_progress" | "completed"; priority: string }[];
}
export interface ChatEntryHelp { kind: "help"; lines: { kind: "heading" | "cmd" | "danger" | "text"; text: string }[] }
export interface ChatEntryDivider { kind: "divider" }

export type ChatEntry =
  | ChatEntryUser | ChatEntryAssistant | ChatEntryThought | ChatEntryMeta
  | ChatEntryNotice | ChatEntryTool | ChatEntryPlan | ChatEntryHelp | ChatEntryDivider;

export interface PermissionOptionView { id: string; name: string; danger: boolean }
export type DialogFrame =
  | { kind: "permission"; toolTitle: string; borderDanger: boolean; options: PermissionOptionView[]; selected: number }
  | { kind: "model-picker"; models: { modelId: string; name: string; current: boolean }[]; selected: number }
  | { kind: "confirm-full-access" };

export interface Frame {
  appName: string;
  modelLabel: string; // may carry trailing "*" when the switch applies next turn
  cwd: string;
  modeId: ModeId;
  rows: number;
  cols: number;
  scroll: number; // chat scroll offset in lines; 0 = stick to bottom
  chat: ChatEntry[];
  streaming?: { text: string; thinking: boolean };
  dialog?: DialogFrame;
  inputText: string;
  inputCursorText: number; // index into inputText
  inputCursorCol: number;  // display column of the cursor
  busy: boolean;
  canSend: boolean;
  spinnerTick: number; // ms counter for in_progress animations
}

const SPINNER = ["[=------]", "[-=-----]", "[--=----]", "[---=---]", "[----=--]", "[-----=-]", "[------=]", "[-----=-]", "[----=--]", "[---=---]", "[--=----]", "[-=-----]"];

export function fmtTime(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Split plain text into lines wrapped at `width` display columns. */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine === "") { out.push(""); continue; }
    let line = "";
    let w = 0;
    for (const ch of rawLine) {
      const cw = stringWidth(ch);
      if (w + cw > width) { out.push(line); line = ch; w = cw; }
      else { line += ch; w += cw; }
    }
    out.push(line);
  }
  return out;
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Trim a possibly-ANSI row to exactly `cols` display columns and pad right. */
function fitRow(painted: string, cols: number): string {
  const plain = stripAnsi(painted);
  const w = stringWidth(plain);
  if (w <= cols) return painted + " ".repeat(cols - w);
  const { text } = truncateWidth(plain, cols);
  // Repaint from plain text with the same style would require carrying the
  // style — simpler: clip and re-wrap with no color for the tail. To keep the
  // row width exact we just return the clipped plain tail (rare overflow case).
  return text;
}

/** Compute char index in `s` such that the display width of s[0..idx) <= maxWidth. */
function charIndexAtWidthLocal(s: string, maxWidth: number): number {
  let w = 0;
  let i = 0;
  for (const ch of s) {
    const cw = stringWidth(ch);
    if (w + cw > maxWidth) break;
    w += cw;
    i += ch.length;
  }
  return i;
}

const strip = (s: string) => stripAnsi(s);
const W = (s: string) => stringWidth(s);

export function renderFrame(frame: Frame, theme: Theme, stdout: { write(s: string): void }): void {
  const { rows, cols } = frame;
  if (rows < 4 || cols < 10) {
    // Invalidate the diff cache too: when the terminal grows back we must
    // repaint everything, not skip rows that match a stale-width frame.
    invalidateFrame(stdout);
    stdout.write(C.err(theme, `terminal too small (${cols}x${rows}), resize`));
    return;
  }
  const rowsOut: string[] = [];

  // ── status bar (row 0) ─────────────────────────────────────────────
  const leftPlain = truncateWidth(`${frame.appName} · ${frame.modelLabel} · ${frame.cwd}`, Math.max(4, cols - 24)).text;
  const left = paint(theme, theme.whiteBright, leftPlain);
  const badgePlain = frame.modeId === "auto" ? "[FULL ACCESS]" : "[STANDARD ACCESS]";
  const badge = frame.modeId === "auto" ? C.badgeFull(theme, badgePlain) : C.badgeStandard(theme, badgePlain);
  const pad = Math.max(1, cols - W(leftPlain) - badgePlain.length - 1);
  rowsOut.push(left + " ".repeat(pad) + badge);

  // ── full-access banner ─────────────────────────────────────────────
  if (frame.modeId === "auto") {
    rowsOut.push(C.banner(theme, "! FULL ACCESS: mutating tools will not ask for confirmation"));
  }

  // ── dialogs sit just above the input row ───────────────────────────
  const inputRow = rows - 1;
  const dialogLines: string[] = [];
  if (frame.dialog) dialogLines.push(...composeDialog(frame.dialog, theme, cols));
  const dialogTop = inputRow - dialogLines.length;
  const chatBottom = dialogLines.length > 0 ? dialogTop - 1 : inputRow - 1;
  if (chatBottom < 1) { /* tiny terminal; still try to draw something */ }

  // ── chat region ────────────────────────────────────────────────────
  const chatLines: string[] = [];
  for (const entry of frame.chat) {
    chatLines.push(...composeChatEntry(entry, theme, cols));
    chatLines.push("");
  }
  if (frame.streaming) chatLines.push(...composeAssistantText(frame.streaming.text, frame.streaming.thinking, theme, cols));
  while (chatLines.length > 0 && chatLines[chatLines.length - 1] === "") chatLines.pop();

  const chatRegionRows = Math.max(0, chatBottom);
  const total = chatLines.length;
  const maxScroll = Math.max(0, total - chatRegionRows);
  const scroll = Math.min(frame.scroll, maxScroll);
  const start = total > chatRegionRows ? total - chatRegionRows - scroll : 0;
  for (let y = 1; y <= chatBottom; y++) {
    const idx = start + (y - 1);
    rowsOut.push(idx >= 0 && idx < total ? chatLines[idx] ?? "" : "");
  }
  for (const dl of dialogLines) rowsOut.push(dl);

  // ── input row ──────────────────────────────────────────────────────
  rowsOut.push(composeInputRow(frame, theme, cols));

  writeDiffed(rowsOut, rows, cols, stdout);
}

function composeInputRow(frame: Frame, theme: Theme, cols: number): string {
  const prompt = "> ";
  const text = frame.inputText;
  const maxTextW = Math.max(0, cols - W(prompt) - 1);
  const textW = W(text);
  let visible = text;
  let cutStart = 0;
  if (textW > maxTextW) {
    const before = text.slice(0, frame.inputCursorText);
    const beforeW = W(before);
    if (beforeW >= maxTextW - 1) {
      cutStart = charIndexAtWidthLocal(text, beforeW - (maxTextW - 1));
    }
    const { text: t2 } = truncateWidth(text.slice(cutStart), maxTextW);
    visible = t2;
  }
  const visCursor = Math.max(0, frame.inputCursorCol - W(text.slice(0, cutStart)));
  const cutAt = charIndexAtWidthLocal(visible, visCursor);
  const before = visible.slice(0, cutAt);
  const after = visible.slice(cutAt);
  const curChar = after.length > 0 ? after[0] ?? " " : " ";
  const afterRest = after.length > 0 ? after.slice(after[0]!.length) : "";
  let row = paint(theme, theme.green, prompt);
  row += paint(theme, theme.whiteBright, before);
  row += theme.enabled ? `\x1b[7m${curChar}\x1b[0m` : curChar;
  row += paint(theme, theme.whiteBright, afterRest);
  if (frame.busy) row += C.meta(theme, "  (Ctrl+C to cancel)");
  return fitRow(row, cols);
}

function composeChatEntry(entry: ChatEntry, theme: Theme, cols: number): string[] {
  const bodyWidth = Math.max(1, cols - 4);
  switch (entry.kind) {
    case "user": {
      const head = "> 你";
      const lines: string[] = [];
      lines.push(C.user(theme, head) + (entry.time ? rightPad(head, entry.time, cols, C.meta(theme, entry.time)) : ""));
      for (const l of wrapText(entry.text, bodyWidth)) lines.push(paint(theme, theme.green, "  " + l));
      return lines;
    }
    case "assistant":
      return composeAssistantText(entry.text, false, theme, cols, entry.time);
    case "thought":
    case "meta":
      return [C.meta(theme, "  " + entry.text)];
    case "notice":
      if (entry.danger === true) return [C.err(theme, "! " + entry.text)];
      if (entry.danger === false) return [C.ok(theme, entry.text)];
      return [paint(theme, theme.white, "  " + entry.text)];
    case "divider":
      return [paint(theme, theme.dim, "  " + "-".repeat(Math.max(1, cols - 4)))];
    case "help": {
      const out: string[] = [];
      for (const l of entry.lines) {
        if (l.text === "") { out.push(""); continue; }
        const style = l.kind === "heading" ? theme.whiteBright : l.kind === "cmd" ? theme.green : l.kind === "danger" ? theme.redBright : theme.white;
        out.push(paint(theme, style, "  " + l.text));
      }
      return out;
    }
    case "plan": {
      const out: string[] = [C.heading(theme, "  Plan")];
      for (const e of entry.entries) {
        const mark = e.status === "completed" ? "[x]" : e.status === "in_progress" ? "[>]" : "[ ]";
        const style = e.status === "completed" ? theme.green : e.status === "in_progress" ? theme.whiteBright : theme.dim;
        const wrapped = wrapText(e.content, bodyWidth - 6);
        if (wrapped.length === 0) out.push(paint(theme, style, "  " + mark));
        for (let i = 0; i < wrapped.length; i++) {
          out.push(i === 0 ? paint(theme, style, "  " + mark + " " + wrapped[i]) : paint(theme, style, "       " + wrapped[i]));
        }
      }
      return out;
    }
    case "tool":
      return composeToolRow(entry, theme, cols);
  }
}

function composeAssistantText(text: string, thinking: boolean, theme: Theme, cols: number, time?: string): string[] {
  const head = "> ZhenTe";
  const lines: string[] = [];
  lines.push(C.heading(theme, head) + (time ? rightPad(head, time, cols, C.meta(theme, time)) : ""));
  if (thinking) lines.push(C.meta(theme, "  (thinking…)"));
  if (text) {
    for (const l of wrapText(text, Math.max(1, cols - 4))) lines.push(paint(theme, theme.white, "  " + l));
  } else if (!thinking) {
    lines.push(C.meta(theme, "  (empty reply)"));
  }
  return lines;
}

function composeToolRow(entry: ChatEntryTool, theme: Theme, cols: number): string[] {
  const running = entry.status === "in_progress";
  const elapsed = Math.max(0, Math.floor((Date.now() - entry.startedAt) / 1000));
  const statusText = running ? `${SPINNER[Math.floor(Date.now() / 180) % SPINNER.length]} ${elapsed}s` : entry.status === "completed" ? "完成" : "失败";
  const statusStyle = running ? theme.whiteBright : entry.status === "completed" ? theme.green : theme.red;
  const tag = running ? (entry.danger ? paint(theme, theme.red, "[!]") : paint(theme, theme.green, "[tool]")) : C.meta(theme, "[tool]");
  const title = truncateWidth(entry.title, Math.max(10, cols - 32)).text;
  let line = `${tag} ${paint(theme, theme.white, title)}`;
  const statusPainted = paint(theme, statusStyle, statusText);
  const timeSuffix = entry.finishedAt ? C.meta(theme, " " + entry.finishedAt) : "";
  const tail = strip(statusPainted + timeSuffix);
  line += " ".repeat(Math.max(1, cols - W(strip(line)) - W(tail))) + statusPainted + timeSuffix;
  const out = [line];
  if (entry.detail) out.push(C.meta(theme, "    $ " + truncateWidth(entry.detail, Math.max(10, cols - 8)).text));
  if (entry.expanded && entry.output) {
    for (const l of wrapText(entry.output, Math.max(10, cols - 8))) out.push(C.meta(theme, "    " + l));
  }
  return out;
}

function rightPad(left: string, time: string, cols: number, timePainted: string): string {
  const pad = Math.max(1, cols - W(left) - W(time));
  return " ".repeat(pad) + timePainted;
}

function composeDialog(dialog: DialogFrame, theme: Theme, cols: number): string[] {
  const innerW = Math.max(10, cols - 6);
  switch (dialog.kind) {
    case "permission": {
      const borderStyle = dialog.borderDanger ? theme.red : theme.green;
      const lines: string[] = [];
      const title = truncateWidth(dialog.toolTitle, innerW - 6).text;
      const dash = "-".repeat(Math.max(1, innerW - W(title) - 4));
      lines.push(paint(theme, borderStyle, "+-- " + title + " " + dash + "+"));
      for (let i = 0; i < dialog.options.length; i++) {
        const opt = dialog.options[i]!;
        const sel = i === dialog.selected;
        const style = opt.danger ? theme.red : theme.green;
        const label = sel ? paint(theme, style + theme.bold, "[" + (i + 1) + "] " + opt.name) : paint(theme, style, "[" + (i + 1) + "] " + opt.name);
        const arrow = sel ? paint(theme, theme.greenBright, " <") : "";
        lines.push("  " + label + arrow);
      }
      lines.push(paint(theme, borderStyle, "+" + "-".repeat(innerW) + "+"));
      return lines;
    }
    case "model-picker": {
      const borderStyle = theme.green;
      const lines: string[] = [];
      lines.push(paint(theme, borderStyle, "+-- model: up/down select, Enter confirm, Esc cancel --+"));
      for (let i = 0; i < dialog.models.length; i++) {
        const m = dialog.models[i]!;
        const sel = i === dialog.selected;
        const star = m.current ? "*" : " ";
        const base = star + " " + m.modelId;
        let label: string;
        if (sel) {
          label = paint(theme, theme.greenBright, "> " + base);
        } else if (m.current) {
          label = paint(theme, theme.green, "  " + base);
        } else {
          label = paint(theme, theme.white, "  " + base);
        }
        lines.push(label);
      }
      lines.push(paint(theme, borderStyle, "+" + "-".repeat(innerW) + "+"));
      return lines;
    }
    case "confirm-full-access": {
      const lines: string[] = [];
      lines.push(C.err(theme, "+-- FULL ACCESS --+"));
      lines.push(C.banner(theme, "  切换为 FULL ACCESS？变更将不再请求确认"));
      lines.push(paint(theme, theme.white, "  [y] 确认进入  ·  [n]/Esc 取消"));
      lines.push(C.err(theme, "+" + "-".repeat(innerW) + "+"));
      return lines;
    }
  }
}

const prevRows: string[] = [];

/**
 * Drop the dirty-row diff cache. Call before a full repaint when the previous
 * frame no longer matches the terminal (resize, alternate-screen reset): stale
 * "same content" rows would otherwise be skipped while the terminal has
 * already reflowed. Optionally clears the screen too.
 */
export function invalidateFrame(stdout?: { write(s: string): void }): void {
  prevRows.length = 0;
  if (stdout) stdout.write("\x1b[2J\x1b[H");
}

export function writeDiffed(rows: string[], totalRows: number, cols: number, stdout: { write(s: string): void }): void {
  // Diff against the previous frame; only rewrite changed rows. Frames have a
  // fixed row count so clearing below is unnecessary.
  let buf = "\x1b[?25l";
  for (let y = 0; y < totalRows; y++) {
    const cur = rows[y] ?? "";
    const prev = prevRows[y];
    if (prev === cur) continue;
    prevRows[y] = cur;
    // Do NOT slice by JS string length: ANSI escapes inflate it and would chop
    // visible text. Rows are composed already-fitted to `cols` display columns;
    // only a misbehaving wide row falls back to plain-text truncation.
    let fitted: string;
    if (stringWidth(stripAnsi(cur)) <= cols) {
      fitted = cur;
    } else {
      fitted = truncateWidth(stripAnsi(cur), cols).text;
    }
    // Erase to end of line: chat/tool/dialog rows are not padded to `cols`, so
    // a shorter (or blank) row would otherwise leave stale glyphs behind.
    buf += `\x1b[${y + 1};1H${fitted}\x1b[K`;
  }
  prevRows.length = totalRows;
  stdout.write(buf);
}
