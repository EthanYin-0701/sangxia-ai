/**
 * Red / green / white CRT theme (§5 of plan/tui_support.md).
 *
 * Only three foreground hues (each with a bright tier) + dim + optional black
 * background. Colors are never the sole channel: every colored element also
 * carries text (tool rows print 完成/失败, Full Access prints a text badge and
 * banner). `NO_COLOR` strips all ANSI colors but keeps the text.
 */

export interface Theme {
  /** ANSI prefix that sets the given semantic style ("" when disabled). */
  white: string;
  whiteBright: string;
  green: string;
  greenBright: string;
  red: string;
  redBright: string;
  dim: string;
  bold: string;
  bg: string; // optional black background (--crt)
  reset: string;
  enabled: boolean;
}

export interface ThemeOptions {
  crt: boolean;
  noColor: boolean;
}

export const ANSI = {
  white: "\x1b[37m",
  whiteBright: "\x1b[97m",
  green: "\x1b[32m",
  greenBright: "\x1b[92m",
  red: "\x1b[31m",
  redBright: "\x1b[91m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  bg: "\x1b[40m",
  reset: "\x1b[0m",
} as const;

export function makeTheme(opts: ThemeOptions): Theme {
  if (opts.noColor) {
    return {
      white: "", whiteBright: "", green: "", greenBright: "",
      red: "", redBright: "", dim: "", bold: "", bg: "", reset: "", enabled: false,
    };
  }
  return {
    white: ANSI.white,
    whiteBright: ANSI.whiteBright,
    green: ANSI.green,
    greenBright: ANSI.greenBright,
    red: ANSI.red,
    redBright: ANSI.redBright,
    dim: ANSI.dim,
    bold: ANSI.bold,
    bg: opts.crt ? ANSI.bg : "",
    reset: ANSI.reset,
    enabled: true,
  };
}

/** Wrap `text` in a style (no-op when the style string is empty). */
export function paint(theme: Theme, style: string, text: string): string {
  if (!style) return text;
  return `${style}${text}${theme.reset}`;
}

/** Semantic paint helpers used by the renderer. */
export const colors = {
  user: (t: Theme, s: string) => paint(t, t.green, s),
  assistant: (t: Theme, s: string) => paint(t, t.white, s),
  meta: (t: Theme, s: string) => paint(t, t.dim, s),
  ok: (t: Theme, s: string) => paint(t, t.green, s),
  fail: (t: Theme, s: string) => paint(t, t.red, s),
  err: (t: Theme, s: string) => paint(t, t.redBright, s),
  banner: (t: Theme, s: string) => paint(t, `${t.redBright}${t.bold}`, s),
  badgeStandard: (t: Theme, s: string) => paint(t, `${t.green}${t.bold}`, s),
  badgeFull: (t: Theme, s: string) => paint(t, `${t.red}${t.bold}`, s),
  highlight: (t: Theme, s: string) => paint(t, t.greenBright, s),
  heading: (t: Theme, s: string) => paint(t, t.whiteBright, s),
  cmd: (t: Theme, s: string) => paint(t, t.green, s),
};
