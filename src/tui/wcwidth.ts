/**
 * Minimal East-Asian display-width calculator (wcwidth.ts).
 *
 * Used for every piece of text the TUI lays out (status bar, chat, tool rows,
 * input line). CJK counts 2 columns; combining/format characters count 0.
 * Kept dependency-free. Emoji are approximated: most pictographs count 2,
 * skin-tone modifiers count 0 — good enough because UI symbols are ASCII and
 * the remaining error only affects user-pasted emoji in wrapped lines.
 */

// Zero-width: nonspacing/enclosing combining marks, format chars (joiners,
// bidi controls, variation selectors), ZWJ. Approximated with Unicode
// property escapes (Node 20+ supports \p{...} with the u flag).
const ZW_RE = /[\p{Mn}\p{Me}\p{Cf}\u200d\ufe0f]/u;

// East Asian Wide / Fullwidth + common emoji blocks (approximate EAW=W|F).
const WIDE_RE =
  /[\u{1100}-\u{115f}\u{2e80}-\u{303e}\u{3041}-\u{33ff}\u{3400}-\u{4dbf}\u{4e00}-\u{9fff}\u{a000}-\u{a4cf}\u{a960}-\u{a97c}\u{ac00}-\u{d7a3}\u{f900}-\u{faff}\u{fe10}-\u{fe19}\u{fe30}-\u{fe6f}\u{ff00}-\u{ff60}\u{ffe0}-\u{ffe6}\u{1f004}\u{1f0cf}\u{1f18e}\u{1f191}-\u{1f19a}\u{1f200}-\u{1f320}\u{1f330}-\u{1f335}\u{1f337}-\u{1f37c}\u{1f380}-\u{1f393}\u{1f3a0}-\u{1f3ca}\u{1f3cf}-\u{1f3d3}\u{1f3e0}-\u{1f3f0}\u{1f3f4}\u{1f3f8}-\u{1f43e}\u{1f440}\u{1f442}-\u{1f4fc}\u{1f4ff}-\u{1f53d}\u{1f54b}-\u{1f54e}\u{1f550}-\u{1f567}\u{1f57a}\u{1f595}\u{1f596}\u{1f5a4}\u{1f5fb}-\u{1f64f}\u{1f680}-\u{1f6c5}\u{1f6cc}\u{1f6d0}-\u{1f6d2}\u{1f6eb}\u{1f6ec}\u{1f6f4}-\u{1f6f8}\u{1f910}-\u{1f93e}\u{1f940}-\u{1f94c}\u{1f950}-\u{1f96b}\u{1f980}-\u{1f997}\u{1f9c0}\u{1f9d0}-\u{1f9e6}\u{1fa70}-\u{1faff}\u{20000}-\u{3fffd}]/u;

/** Display width of a single character: 0, 1, or 2. */
export function charWidth(ch: string): number {
  if (ZW_RE.test(ch)) return 0;
  if (WIDE_RE.test(ch)) return 2;
  const code = ch.codePointAt(0) ?? 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0; // control chars
  return 1;
}

/** Display width of a string (0 for empty). */
export function stringWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

/**
 * Truncate `s` to at most `maxWidth` display columns. Optional ASCII `suffix`
 * is appended when truncation happened. Returns text + whether it was cut.
 */
export function truncateWidth(
  s: string,
  maxWidth: number,
  suffix = "",
): { text: string; truncated: boolean } {
  if (maxWidth <= 0) return { text: "", truncated: s.length > 0 };
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > maxWidth) {
      if (suffix && w + stringWidth(suffix) <= maxWidth) out += suffix;
      return { text: out, truncated: true };
    }
    w += cw;
    out += ch;
  }
  return { text: out, truncated: false };
}

/** Index in `s` (code units) up to which the display width <= maxWidth. */
export function charIndexAtWidth(s: string, maxWidth: number): number {
  let w = 0;
  let i = 0;
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > maxWidth) break;
    w += cw;
    i += ch.length;
  }
  return i;
}
