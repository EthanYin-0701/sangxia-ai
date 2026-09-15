import type { ChatMessage, ToolSchema } from "../llm/types.js";

/**
 * Prompt-size estimation (H3②: observability, step 10a).
 *
 * This is a *heuristic*, used only for threshold decisions and logging — it
 * never replaces a provider's tokenizer and is never sent anywhere.
 *
 * Weights come from the common rule of thumb: ~4 ASCII characters per token,
 * while CJK/emoji cost roughly one token per character (hence `/1.5` as a
 * deliberately conservative middle ground for non-ASCII text, since one token
 * usually covers 1–1.5 such characters).
 */
const ASCII_CHARS_PER_TOKEN = 4;
const NON_ASCII_CHARS_PER_TOKEN = 1.5;

/** Structural overhead per message (role markers, separators). */
const TOKENS_PER_MESSAGE = 4;

export function estimateTokens(messages: ChatMessage[], tools: ToolSchema[] = []): number {
  let tokens = 0;
  for (const message of messages) tokens += TOKENS_PER_MESSAGE + estimateText(message.content);
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      tokens += estimateText(call.name) + estimateText(call.arguments);
    }
  }
  // Tool schemas are re-sent with every request, so they cost prompt tokens too.
  for (const tool of tools) tokens += estimateText(tool.name) + estimateText(tool.description) + estimateText(JSON.stringify(tool.parameters));
  return tokens;
}

/** Estimate the token count of one string. */
export function estimateText(text: string | null | undefined): number {
  if (!text) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! < 0x80) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN + nonAscii / NON_ASCII_CHARS_PER_TOKEN);
}

/**
 * Calibrate a fresh estimate with the provider's last reported `prompt_tokens`
 * for an equivalent request shape (step 10a).
 *
 * Backends that honor `stream_options.include_usage` tell us the real number,
 * which is much better than our heuristic — but only for the *previous*
 * request. Rather than trusting either blindly we scale the heuristic by the
 * observed ratio, clamped so one odd measurement can't distort it.
 */
export function calibrateEstimate(
  estimate: number,
  previousEstimate: number | null,
  actualPromptTokens: number | null,
): number {
  if (!previousEstimate || !actualPromptTokens || previousEstimate <= 0) return estimate;
  const ratio = Math.min(2, Math.max(0.5, actualPromptTokens / previousEstimate));
  return Math.round(estimate * ratio);
}

/** Whether a prompt this large should trigger compaction (used from step 10b on). */
export function shouldCompact(estimate: number, contextWindowTokens: number, thresholdRatio: number): boolean {
  return estimate >= contextWindowTokens * thresholdRatio;
}
