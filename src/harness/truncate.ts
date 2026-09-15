/**
 * Head+tail truncation helpers.
 *
 * Tool output used to be truncated keeping only the head, but build/test
 * failures (and any "what went wrong" line) live at the end of the stream —
 * keeping the head alone hides exactly the part the model needs. These helpers
 * keep both ends and elide the middle.
 *
 * Both the one-shot `truncateMiddle` and the incremental
 * `createHeadTailBuffer` share {@link truncationMarker} so the two paths can't
 * drift apart in wording.
 */

/** The single ellipsis marker used by every truncation path. */
export function truncationMarker(dropped: number, total: number): string {
  return `\n…(输出过长，已省略中间 ${dropped} 字符，共 ${total} 字符；头部与尾部为原始输出)\n`;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Slice `[0, end)` without splitting a surrogate pair. */
function safeHead(text: string, end: number): string {
  if (end <= 0) return "";
  if (end >= text.length) return text;
  return isLowSurrogate(text.charCodeAt(end)) ? text.slice(0, end - 1) : text.slice(0, end);
}

/** Slice `[start, ∞)` without splitting a surrogate pair. */
function safeTail(text: string, start: number): string {
  if (start <= 0) return text;
  if (start >= text.length) return "";
  return isLowSurrogate(text.charCodeAt(start)) ? text.slice(start + 1) : text.slice(start);
}

/**
 * Keep the first `floor(limit / 2)` and the last `limit - floor(limit/2)`
 * characters, replacing the middle with {@link truncationMarker}.
 * The result is never longer than `limit + marker.length`.
 */
export function truncateMiddle(text: string, limit: number): string {
  if (limit <= 0) return truncationMarker(text.length, text.length);
  if (text.length <= limit) return text;
  const head = safeHead(text, Math.floor(limit / 2));
  const tail = safeTail(text, text.length - (limit - Math.floor(limit / 2)));
  const dropped = text.length - head.length - tail.length;
  return head + truncationMarker(dropped, text.length) + tail;
}

export interface HeadTailBuffer {
  /** Append a chunk; content past the tail budget is dropped from the front. */
  push(chunk: string): void;
  /** The accumulated output, with the elision marker once anything was dropped. */
  text(): string;
  /** Number of characters dropped so far (0 while everything fits). */
  dropped(): number;
}

/**
 * Streaming head+tail buffer for长输出的增量累积（bash 本地路径）。
 * Once the head budget is full, the rest goes into a tail window that is
 * trimmed from the front, so the end of the output is always preserved.
 */
export function createHeadTailBuffer(limit: number): HeadTailBuffer {
  const headBudget = Math.floor(limit / 2);
  const tailBudget = Math.max(0, limit - headBudget);
  let head = "";
  let tail = "";
  let dropped = 0;
  let total = 0;

  return {
    push(chunk: string): void {
      total += chunk.length;
      let rest = chunk;
      if (head.length < headBudget) {
        let take = Math.min(headBudget - head.length, rest.length);
        // Don't split a surrogate pair across the head/tail boundary.
        if (take > 0 && take < rest.length && isLowSurrogate(rest.charCodeAt(take))) take--;
        head += rest.slice(0, take);
        rest = rest.slice(take);
      }
      if (rest.length === 0) return;
      tail += rest;
      if (tail.length > tailBudget) {
        let over = tail.length - tailBudget;
        // Don't start the tail on the low half of a surrogate pair.
        if (over > 0 && over < tail.length && isLowSurrogate(tail.charCodeAt(over))) over++;
        dropped += over;
        tail = tail.slice(over);
      }
    },
    text(): string {
      return dropped === 0 ? head + tail : head + truncationMarker(dropped, total) + tail;
    },
    dropped(): number {
      return dropped;
    },
  };
}
