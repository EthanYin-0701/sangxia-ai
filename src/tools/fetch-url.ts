import type { PermissionScope, Tool, ToolResult } from "../harness/tool.js";
import { truncateMiddle } from "../harness/truncate.js";
import { VERSION } from "../version.js";
import { htmlToMarkdown } from "./html-to-markdown.js";

/** Bytes read from the response body at most; the rest is never downloaded. */
const MAX_BODY_BYTES = 2_000_000;
const DEFAULT_MAX_CHARS = 50_000;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 60_000;

const TEXT_TYPES = /^(text\/|application\/(json|ld\+json|xml|rss\+xml|atom\+xml|javascript|x-javascript|yaml|x-yaml|toml)\b|[^;]*\+(json|xml)\b)/i;
const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)\b/i;

/** `http(s)` URL or `undefined` (relative, other scheme, garbage). */
function parseHttpUrl(value: unknown): URL | undefined {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Permission scope: "always allow" covers one origin. Redirects are followed
 * only within that origin (see `run`), so an approval can't be stretched to a
 * different host by the server.
 */
function fetchPermissionScope(url: unknown): PermissionScope {
  const parsed = parseHttpUrl(url);
  if (!parsed) return { lookup: [], remember: "fetch_url:invalid", forceAsk: "URL 无效或协议不受支持", ignoreRemembered: true };
  const key = `fetch_url:origin:${parsed.origin}`;
  return { lookup: [key], remember: key, label: parsed.origin };
}

/** Read at most `limit` bytes of the body, cancelling the rest of the stream. */
async function readCapped(res: Response, limit: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = limit - size;
      if (value.byteLength >= room) {
        chunks.push(value.subarray(0, room));
        size += room;
        truncated = value.byteLength > room;
        if (!truncated) {
          const next = await reader.read();
          truncated = !next.done;
        }
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

function decode(bytes: Uint8Array, contentType: string): string {
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/**
 * Fetch a web page and return it as Markdown (SA-10).
 *
 * Network access can leak workspace content through the URL itself, so the
 * tool needs permission like `bash`, remembered per origin. Cross-origin
 * redirects are *reported* to the model instead of followed — it can call
 * again with the new URL, which then gets its own permission decision.
 */
export const fetchUrlTool: Tool = {
  name: "fetch_url",
  description:
    "通过 HTTP(S) GET 拉取一个网页或文本资源并返回内容：HTML 会转换成 Markdown（标题、段落、链接、列表、代码、表格），" +
    "JSON/纯文本原样返回，不支持二进制内容。只跟随同源重定向；跨源重定向会返回新地址，需要时请用新 URL 再调用。" +
    "适合查阅文档、Issue、发行说明等；不要用它访问本地文件。",
  kind: "fetch",
  needsPermission: true,
  timeoutMs: FETCH_TIMEOUT_MS,
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", format: "uri", pattern: "^[hH][tT][tT][pP][sS]?://", description: "要拉取的 http(s) 地址" },
      max_chars: {
        type: "integer",
        minimum: 1000,
        maximum: 100_000,
        description: `返回内容的最大字符数（默认 ${DEFAULT_MAX_CHARS}，超出时保留头尾）`,
      },
      raw: { type: "boolean", description: "为 true 时 HTML 不做 Markdown 转换，返回原始文本" },
    },
    required: ["url"],
    additionalProperties: false,
  },
  title: (a) => `拉取 ${String(a.url)}`,
  permissionScope: (a) => fetchPermissionScope(a.url),
  run: async (a, ctx): Promise<ToolResult> => {
    const requested = parseHttpUrl(a.url);
    if (!requested) return { output: "Error: 只支持 http(s) 绝对地址", isError: true };
    const maxChars = typeof a.max_chars === "number" ? a.max_chars : DEFAULT_MAX_CHARS;

    let url = requested;
    let res: Response | undefined;
    for (let hop = 0; ; hop++) {
      res = await fetch(url, {
        redirect: "manual",
        signal: ctx.signal,
        headers: {
          "user-agent": `sangxia-ai/${VERSION} (+https://github.com/EthanYin-0701/sangxia-ai)`,
          accept: "text/html, text/markdown, text/plain, application/json;q=0.9, */*;q=0.5",
        },
      });
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !location) break;
      await res.body?.cancel().catch(() => {});
      let next: URL | undefined;
      try {
        next = new URL(location, url);
      } catch {
        next = undefined;
      }
      if (!next || (next.protocol !== "http:" && next.protocol !== "https:")) {
        return { output: `Error: 重定向目标无效：${location}`, isError: true };
      }
      if (next.origin !== requested.origin) {
        return {
          output: `重定向到其他站点（HTTP ${res.status}）：${next.href}\n未自动跟随。如需该内容，请用这个 URL 重新调用 fetch_url。`,
          raw: { status: res.status, redirect: next.href },
        };
      }
      if (hop + 1 >= MAX_REDIRECTS) return { output: `Error: 重定向次数超过 ${MAX_REDIRECTS} 次`, isError: true };
      url = next;
    }

    const contentType = res.headers.get("content-type") ?? "";
    const header = `URL: ${url.href}\nHTTP ${res.status}${contentType ? `\nContent-Type: ${contentType}` : ""}`;
    if (contentType && !TEXT_TYPES.test(contentType)) {
      await res.body?.cancel().catch(() => {});
      return { output: `Error: 不支持的内容类型（${contentType}），fetch_url 只返回文本\n\n${header}`, isError: true, raw: { status: res.status, contentType } };
    }

    const { bytes, truncated } = await readCapped(res, MAX_BODY_BYTES);
    const text = decode(bytes, contentType);
    const isHtml = HTML_TYPES.test(contentType) || (!contentType && /^\s*<(!doctype html|html)\b/i.test(text));
    let body = text;
    let title: string | undefined;
    if (isHtml && a.raw !== true) {
      const converted = htmlToMarkdown(text, url.href);
      body = converted.markdown;
      title = converted.title;
    }
    const notes = truncated ? `\n（响应超过 ${MAX_BODY_BYTES} 字节，只读取了开头部分）` : "";
    const output = `${header}${title ? `\nTitle: ${title}` : ""}${notes}\n\n${truncateMiddle(body, maxChars) || "(空响应)"}`;
    const raw = { status: res.status, url: url.href, contentType, bytes: bytes.byteLength, truncated };
    if (!res.ok) return { output: `Error: HTTP ${res.status}\n\n${output}`, isError: true, raw };
    return { output, raw };
  },
};
