/**
 * Two-press quit gate for the TUI (quit-gate.ts).
 *
 * While a turn is running Ctrl+C means "cancel the turn", and while typing it
 * means "clear the line" — so an idle Ctrl+C quitting outright would be a
 * footgun (one stray press kills the session). Instead the first press *arms*
 * the gate and the input row shows "press Ctrl+C again to exit"; a second
 * press inside the window really quits, any other key press or the window
 * expiring disarms it, so a stale press can never exit an hour later.
 *
 * The caller owns the timer and the repaint; this class owns only the state,
 * which keeps the decision testable without a terminal (injectable clock).
 */

/** How long the second Ctrl+C is accepted after the first one (ms). */
export const QUIT_ARM_MS = 2000;

export class QuitGate {
  #armedUntil = 0;
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  /** Arm the gate for one `QUIT_ARM_MS` window starting now. */
  arm(): void {
    this.#armedUntil = this.#now() + QUIT_ARM_MS;
  }

  /** True while a second press would quit. */
  get armed(): boolean {
    return this.#now() < this.#armedUntil;
  }

  /** Milliseconds left in the window (0 when not armed). */
  remaining(): number {
    return Math.max(0, this.#armedUntil - this.#now());
  }

  /** Forget the armed state (another key was pressed, or the window lapsed). */
  reset(): void {
    this.#armedUntil = 0;
  }
}
