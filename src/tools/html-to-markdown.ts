/**
 * Dependency-free HTML → Markdown conversion for `fetch_url` (SA-10).
 *
 * The goal is a compact, readable rendering of a web page for the model —
 * headings, paragraphs, links, lists, code, quotes and simple tables — not a
 * faithful round-trip. Markup that carries no readable text (scripts, styles,
 * SVG, forms' hidden state, …) is dropped. Malformed HTML is tolerated: unknown
 * or unbalanced tags degrade to plain text instead of throwing.
 */

export interface HtmlConversion {
  /** Text of `<title>`, if any. */
  title?: string;
  markdown: string;
}

/** Elements dropped together with everything inside them. */
const DROPPED = ["script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "head", "select"];

/** Elements rendered as a paragraph break. */
const BLOCKS = new Set([
  "address", "article", "aside", "body", "dd", "details", "dialog", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "header", "html", "main", "nav", "p", "section", "summary",
]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  mdash: "—", ndash: "–", hellip: "…", middot: "·", bull: "•", times: "×", divide: "÷",
  copy: "©", reg: "®", trade: "™", deg: "°", plusmn: "±", sect: "§", para: "¶",
  laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", euro: "€", pound: "£", yen: "¥", cent: "¢",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of source.matchAll(ATTR_RE)) {
    attrs.set(m[1]!.toLowerCase(), decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return attrs;
}

/** Resolve `href` against `base`; `undefined` for script/data links and garbage. */
function resolveUrl(href: string | undefined, base: string | undefined): string | undefined {
  const value = href?.trim();
  if (!value || /^(javascript|vbscript|data):/i.test(value)) return undefined;
  if (value.startsWith("#")) return undefined;
  try {
    return base ? new URL(value, base).href : new URL(value).href;
  } catch {
    return base ? undefined : value;
  }
}

/** An output buffer opened by an element whose rendering wraps its children. */
interface Frame {
  tag: string;
  out: string;
  /**
   * Whether `out` ends in whitespace. Tracked on write because reading `out`
   * back flattens the string rope, which makes conversion quadratic.
   */
  endsWs?: boolean;
  href?: string;
  /** `table` frames: collected rows; `tr` frames: collected cells. */
  rows?: { cells: string[]; header: boolean }[];
  cells?: string[];
  header?: boolean;
}

/**
 * Convert an HTML document or fragment to Markdown. `baseUrl` resolves relative
 * links and image sources (normally the final URL after redirects).
 */
export function htmlToMarkdown(html: string, baseUrl?: string): HtmlConversion {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? collapse(decodeEntities(titleMatch[1]!.replace(/<[^>]*>/g, ""))).trim() : undefined;

  let source = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<!doctype[^>]*>/gi, "");
  for (const tag of DROPPED) {
    source = source.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, "gi"), "");
    source = source.replace(new RegExp(`<${tag}\\b[^>]*/>`, "gi"), "");
  }
  // <base href> changes how the page itself resolves relative links.
  const baseHref = /<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html);
  const base = resolveUrl(baseHref ? baseHref[1] ?? baseHref[2] ?? baseHref[3] : undefined, baseUrl) ?? baseUrl;

  const stack: Frame[] = [{ tag: "#root", out: "" }];
  const lists: { ordered: boolean; index: number }[] = [];
  let pre = 0;

  const top = () => stack[stack.length - 1]!;
  const emit = (text: string) => {
    if (!text) return;
    const f = top();
    f.out += text;
    f.endsWs = /\s$/.test(text);
  };
  /** Inline markers (`**`, `*`, `~~`, `` ` ``) opened and not yet closed. */
  const inline: string[] = [];
  const toggle = (marker: string, closing: boolean) => {
    if (!closing) {
      inline.push(marker);
      emit(marker);
    } else if (inline.lastIndexOf(marker) >= 0) {
      // Close everything opened inside it too, so markers stay nested.
      while (inline.length > 0) {
        const m = inline.pop()!;
        emit(m);
        if (m === marker) break;
      }
    }
  };
  /** Paragraph break; an unclosed `<b>` must not bold the rest of the page. */
  const block = () => {
    while (inline.length > 0) emit(inline.pop()!);
    emit("\n\n");
  };
  const open = (frame: Frame) => stack.push(frame);
  /** Pop frames down to and including the innermost `tag`; `undefined` if not open. */
  const close = (tag: string): Frame | undefined => {
    let i = stack.length - 1;
    while (i > 0 && stack[i]!.tag !== tag) i--;
    if (i === 0) return undefined;
    while (stack.length - 1 > i) finish(stack.pop()!);
    return stack.pop();
  };
  /** Render a frame into its parent. */
  const finish = (frame: Frame) => {
    switch (frame.tag) {
      case "a": {
        const text = collapse(frame.out).trim();
        if (!frame.href) emit(frame.out);
        else if (!text) emit("");
        else emit(text === frame.href ? `<${frame.href}>` : `[${text}](${frame.href})`);
        break;
      }
      case "blockquote": {
        const body = tidy(frame.out);
        if (body) {
          block();
          emit(body.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n"));
          block();
        }
        break;
      }
      case "td":
      case "th": {
        const row = [...stack].reverse().find((f) => f.tag === "tr");
        const cell = collapse(frame.out).trim().replace(/\|/g, "\\|");
        if (row) {
          row.cells!.push(cell);
          if (frame.tag === "th") row.header = true;
        } else emit(` ${cell} `);
        break;
      }
      case "tr": {
        const table = [...stack].reverse().find((f) => f.tag === "table");
        if (table && frame.cells!.length > 0) table.rows!.push({ cells: frame.cells!, header: Boolean(frame.header) });
        else if (!table) emit(frame.cells!.join(" | "));
        break;
      }
      case "table": {
        block();
        emit(renderTable(frame.rows!));
        block();
        break;
      }
      default:
        emit(frame.out);
    }
  };

  let last = 0;
  const handleText = (raw: string) => {
    if (!raw) return;
    const text = decodeEntities(raw);
    if (pre > 0) {
      emit(text);
      return;
    }
    // Collapse like a browser; no leading space at a line/frame start or after one.
    const collapsed = text.replace(/\s+/g, " ");
    emit(top().out.length === 0 || top().endsWs ? collapsed.trimStart() : collapsed);
  };

  for (const m of source.matchAll(TAG_RE)) {
    handleText(source.slice(last, m.index));
    last = m.index + m[0].length;
    const closing = m[1] === "/";
    const tag = m[2]!.toLowerCase();
    const attrs = closing ? undefined : parseAttrs(m[3] ?? "");

    if (/^h[1-6]$/.test(tag)) {
      block();
      if (!closing) emit(`${"#".repeat(Number(tag[1]))} `);
      continue;
    }
    if (BLOCKS.has(tag)) {
      block();
      continue;
    }
    switch (tag) {
      case "br":
        emit(pre > 0 ? "\n" : "  \n");
        break;
      case "hr":
        block();
        emit("---");
        block();
        break;
      case "pre":
        if (closing) {
          if (pre > 0) {
            pre--;
            emit("\n```");
            block();
          }
        } else {
          pre++;
          block();
          emit("```\n");
        }
        break;
      case "code":
      case "kbd":
      case "samp":
        if (pre === 0) toggle("`", closing);
        break;
      case "strong":
      case "b":
        toggle("**", closing);
        break;
      case "em":
      case "i":
        toggle("*", closing);
        break;
      case "del":
      case "s":
        toggle("~~", closing);
        break;
      case "img": {
        const src = resolveUrl(attrs?.get("src"), base);
        const alt = collapse(attrs?.get("alt") ?? "").trim();
        if (src) emit(`![${alt}](${src})`);
        else if (alt) emit(alt);
        break;
      }
      case "a":
        if (closing) {
          const frame = close("a");
          if (frame) finish(frame);
        } else {
          open({ tag: "a", out: "", href: resolveUrl(attrs?.get("href"), base) });
        }
        break;
      case "ul":
      case "ol":
        if (closing) {
          lists.pop();
        } else {
          const start = Number(attrs?.get("start"));
          lists.push({ ordered: tag === "ol", index: Number.isInteger(start) ? start - 1 : 0 });
        }
        block();
        break;
      case "li":
        if (!closing) {
          const list = lists[lists.length - 1];
          const indent = "  ".repeat(Math.max(0, lists.length - 1));
          let marker = "- ";
          if (list?.ordered) marker = `${++list.index}. `;
          emit(`\n${indent}${marker}`);
        }
        break;
      case "blockquote":
      case "table":
      case "tr":
      case "td":
      case "th":
        if (closing) {
          const frame = close(tag);
          if (frame) finish(frame);
        } else {
          // A new row/cell implicitly closes an unclosed sibling (`<td>a<td>b`).
          if (tag === "tr") closeImplicit(["td", "th", "tr"]);
          if (tag === "td" || tag === "th") closeImplicit(["td", "th"]);
          open({
            tag,
            out: "",
            ...(tag === "table" ? { rows: [] } : {}),
            ...(tag === "tr" ? { cells: [] } : {}),
          });
        }
        break;
      default:
        // Unknown/inline tags (span, label, small, …) keep their text only.
        break;
    }
  }
  handleText(source.slice(last));
  while (inline.length > 0) emit(inline.pop()!);
  while (stack.length > 1) finish(stack.pop()!);

  function closeImplicit(tags: string[]): void {
    // Only within the innermost table: never reach into an outer table's row.
    for (let i = stack.length - 1; i > 0 && stack[i]!.tag !== "table"; i--) {
      if (tags.includes(stack[i]!.tag)) {
        while (stack.length > i) finish(stack.pop()!);
        return;
      }
    }
  }

  return { ...(title ? { title } : {}), markdown: tidy(stack[0]!.out) };
}

function renderTable(rows: { cells: string[]; header: boolean }[]): string {
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.cells.length));
  const line = (cells: string[]) => `| ${[...cells, ...Array(width - cells.length).fill("")].join(" | ")} |`;
  const [first, ...rest] = rows;
  // Markdown tables need a header row; use the first row either way.
  return [line(first!.cells), line(Array(width).fill("---")), ...rest.map((r) => line(r.cells))].join("\n");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ");
}

/**
 * Normalize blank lines and trailing spaces (keeping Markdown hard breaks),
 * leaving fenced code blocks byte-for-byte alone.
 */
function tidy(text: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "```") {
      fenced = !fenced;
      out.push("```");
      continue;
    }
    if (fenced) {
      out.push(line);
      continue;
    }
    const trimmed = /\S {2}$/.test(line) ? line.replace(/\s+$/, "  ") : line.replace(/\s+$/, "");
    if (trimmed === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(trimmed);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}
