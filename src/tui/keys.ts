/**
 * Raw-mode keyboard parser (keys.ts).
 *
 * Replaces `node:readline` for the TUI. Readline's raw line editor cannot be
 * cleanly paused for self-drawn modal overlays (`rl.pause()` leaves its
 * keypress listener consuming bytes — verified in the step-0 spike, where an
 * overlay keystroke landed inside the input line). Instead we put stdin in raw
 * mode once and parse bytes ourselves with one state machine shared by the
 * input line and the modal popups. UTF-8 is decoded incrementally with
 * `StringDecoder`, so multi-byte characters split across read chunks stay
 * intact (IME composition happens in the terminal emulator, so the app only
 * ever sees committed codepoints).
 */

import { StringDecoder } from "node:string_decoder";

export type Key =
  | { type: "char"; char: string }
  | { type: "enter" }
  | { type: "tab" }
  | { type: "shift-tab" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "pgup" }
  | { type: "pgdn" }
  | { type: "shift-up" }
  | { type: "shift-down" }
  | { type: "ctrl-c" }
  | { type: "ctrl-d" }
  | { type: "ctrl-u" }
  | { type: "ctrl-a" }
  | { type: "ctrl-e" }
  | { type: "ctrl-l" }
  | { type: "ctrl-w" }
  | { type: "escape" }
  | { type: "alt"; char: string }
  | { type: "unknown"; seq: string };

/** Whether a key is plain printable text that should append to the input line. */
export function isPrintable(k: Key): k is { type: "char"; char: string } {
  return k.type === "char";
}

export class KeyReader {
  readonly #decoder = new StringDecoder("utf8");
  #pending: string[] = [];
  #onKey: (k: Key) => void;

  constructor(onKey: (k: Key) => void) {
    this.#onKey = onKey;
  }

  /** Feed raw bytes (or already-decoded text) from stdin. */
  push(data: Buffer | string): void {
    const text = typeof data === "string" ? data : this.#decoder.write(data);
    for (const ch of text) this.#pending.push(ch);
    this.#flush();
  }

  #flush(): void {
    while (this.#pending.length > 0) {
      const ch = this.#pending.shift()!;
      // Escape sequence: ESC [ ... final / ESC O ... / ESC + char
      if (ch === "\x1b") {
        if (this.#pending.length === 0) {
          // Lone ESC → the Escape key. (ESC+char sequences always arrive in
          // the same read chunk in practice; if they ever split, the first
          // half is read as Escape — acceptable for v1.)
          this.#emit({ type: "escape" });
          continue;
        }
        const next = this.#pending.shift()!;
        if (next === "[") {
          this.#readCsi();
        } else if (next === "O") {
          this.#readSs3();
        } else {
          // Alt+key (or ESC followed by a control char).
          this.#emit(this.#ctrlKey(next) ?? { type: "alt", char: next });
        }
        continue;
      }
      this.#emit(this.#ctrlKey(ch) ?? { type: "char", char: ch });
    }
  }

  /** After ESC [, consume up to the final byte (0x40–0x7E). */
  #readCsi(): void {
    let params = "";
    while (this.#pending.length > 0) {
      const c = this.#pending.shift()!;
      const code = c.codePointAt(0)!;
      if (code >= 0x40 && code <= 0x7e) {
        this.#emit(this.#mapCsi(params, c));
        return;
      }
      params += c;
    }
    // Unterminated CSI — treat as unknown rather than wedging the parser.
    this.#emit({ type: "unknown", seq: `\x1b[${params}` });
  }

  /** After ESC O (SS3: F1–F4, Home/End/arrows on some terminals). */
  #readSs3(): void {
    if (this.#pending.length === 0) {
      this.#emit({ type: "unknown", seq: "\x1bO" });
      return;
    }
    const c = this.#pending.shift()!;
    switch (c) {
      case "A": this.#emit({ type: "up" }); break;
      case "B": this.#emit({ type: "down" }); break;
      case "C": this.#emit({ type: "right" }); break;
      case "D": this.#emit({ type: "left" }); break;
      case "H": this.#emit({ type: "home" }); break;
      case "F": this.#emit({ type: "end" }); break;
      case "P": this.#emit({ type: "unknown", seq: "\x1bOP" }); break;
      default: this.#emit({ type: "unknown", seq: `\x1bO${c}` });
    }
  }

  #mapCsi(params: string, final: string): Key {
    const [num, mod] = params.split(";");
    const shifted = mod === "2";
    if (final === "~") {
      switch (num) {
        case "1": case "7": return { type: "home" };
        case "3": return { type: "delete" };
        case "4": case "8": return { type: "end" };
        case "5": return { type: "pgup" };
        case "6": return { type: "pgdn" };
        default: return { type: "unknown", seq: `\x1b[${params}~` };
      }
    }
    switch (final) {
      case "A": return shifted ? { type: "shift-up" } : { type: "up" };
      case "B": return shifted ? { type: "shift-down" } : { type: "down" };
      case "C": return { type: "right" };
      case "D": return { type: "left" };
      case "H": return { type: "home" };
      case "F": return { type: "end" };
      case "Z": return { type: "shift-tab" };
      default: return { type: "unknown", seq: `\x1b[${params}${final}` };
    }
  }

  #ctrlKey(ch: string): Key | null {
    switch (ch) {
      case "\r": case "\n": return { type: "enter" };
      case "\t": return { type: "tab" };
      case "\x7f": case "\b": return { type: "backspace" };
      case "\x03": return { type: "ctrl-c" };
      case "\x04": return { type: "ctrl-d" };
      case "\x15": return { type: "ctrl-u" };
      case "\x01": return { type: "ctrl-a" };
      case "\x05": return { type: "ctrl-e" };
      case "\x0c": return { type: "ctrl-l" };
      case "\x17": return { type: "ctrl-w" };
      default: return null;
    }
  }

  #emit(k: Key): void {
    this.#onKey(k);
  }
}
