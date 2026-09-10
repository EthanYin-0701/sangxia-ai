/**
 * Input-line editing model (input.ts).
 *
 * Pure state + operations, no terminal I/O: the renderer draws whatever
 * `render()` returns and the key dispatcher calls the operations. Text is
 * stored as an array of code points so astral characters (surrogate pairs)
 * move the cursor by one visible character.
 */

export interface InputLineState {
  /** Text as an array of code points. */
  chars: string[];
  /** Cursor index into `chars` (0..chars.length). */
  cursor: number;
}

export class InputLine {
  #chars: string[] = [];
  #cursor = 0;
  #history: string[] = [];
  #historyIdx = -1; // -1 = editing a fresh line, >=0 = browsing history
  #savedDraft = ""; // the fresh line while browsing history

  get text(): string {
    return this.#chars.join("");
  }

  get cursor(): number {
    return this.#cursor;
  }

  /** Cursor as an index into the raw text string (for the renderer). */
  get cursorTextIndex(): number {
    return this.#chars.slice(0, this.#cursor).join("").length;
  }

  isEmpty(): boolean {
    return this.#chars.length === 0;
  }

  setText(text: string): void {
    this.#chars = [...text];
    this.#cursor = this.#chars.length;
  }

  insert(ch: string): void {
    if (ch === "") return;
    this.#chars.splice(this.#cursor, 0, ...ch);
    this.#cursor += [...ch].length;
  }

  backspace(): void {
    if (this.#cursor > 0) {
      this.#chars.splice(this.#cursor - 1, 1);
      this.#cursor -= 1;
    }
  }

  /** Forward delete (Ctrl+D / Delete key on some terminals). */
  deleteForward(): void {
    if (this.#cursor < this.#chars.length) {
      this.#chars.splice(this.#cursor, 1);
    }
  }

  deleteToStart(): void {
    this.#chars.splice(0, this.#cursor);
    this.#cursor = 0;
  }

  /** Delete the word before the cursor (Ctrl+W). */
  deleteWordBack(): void {
    let i = this.#cursor;
    // Skip trailing spaces.
    while (i > 0 && this.#chars[i - 1] === " ") i -= 1;
    // Skip the word.
    while (i > 0 && this.#chars[i - 1] !== " ") i -= 1;
    this.#chars.splice(i, this.#cursor - i);
    this.#cursor = i;
  }

  clear(): void {
    this.#chars = [];
    this.#cursor = 0;
  }

  moveLeft(): void {
    this.#cursor = Math.max(0, this.#cursor - 1);
  }

  moveRight(): void {
    this.#cursor = Math.min(this.#chars.length, this.#cursor + 1);
  }

  moveToStart(): void {
    this.#cursor = 0;
  }

  moveToEnd(): void {
    this.#cursor = this.#chars.length;
  }

  /** Commit the current line; returns the text and records it in history. */
  commit(): string {
    const text = this.text;
    if (text.trim() !== "") {
      if (this.#history[this.#history.length - 1] !== text) {
        this.#history.push(text);
      }
    }
    this.#chars = [];
    this.#cursor = 0;
    this.#historyIdx = -1;
    this.#savedDraft = "";
    return text;
  }

  historyUp(): void {
    if (this.#history.length === 0) return;
    if (this.#historyIdx === -1) {
      this.#savedDraft = this.text;
      this.#historyIdx = this.#history.length - 1;
    } else if (this.#historyIdx > 0) {
      this.#historyIdx -= 1;
    } else {
      return;
    }
    this.#chars = [...(this.#history[this.#historyIdx] ?? "")];
    this.#cursor = this.#chars.length;
  }

  historyDown(): void {
    if (this.#historyIdx === -1) return;
    if (this.#historyIdx < this.#history.length - 1) {
      this.#historyIdx += 1;
      this.#chars = [...(this.#history[this.#historyIdx] ?? "")];
      this.#cursor = this.#chars.length;
    } else {
      this.#historyIdx = -1;
      this.#chars = [...this.#savedDraft];
      this.#cursor = this.#chars.length;
    }
  }
}
