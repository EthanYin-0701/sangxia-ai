/**
 * Provider-agnostic LLM abstraction.
 *
 * Messages/tools use an OpenAI-flavored shape because it's the lingua franca of
 * chat + function-calling APIs, but nothing in the harness imports a concrete
 * provider — everything goes through {@link LLMProvider}. Adding a native
 * Anthropic (or other) backend is just another implementation of this interface.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** A tool call requested by the assistant (arguments is a raw JSON string). */
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  /** Present on assistant messages that request tool calls. */
  tool_calls?: ToolCallRequest[];
  /** Present on tool-result messages, referencing the originating call. */
  tool_call_id?: string;
  /**
   * Raw thinking/reasoning text from a prior assistant turn (DeepSeek-style
   * `reasoning_content`), assistant-only. Some backends require this to be
   * echoed back verbatim in every subsequent request that includes `tools`,
   * even for turns that made no tool call — omitting it gets a 400, not a
   * silent ignore (see `llm/openai.ts` `toOpenAIMessages`).
   */
  reasoning_content?: string;
}

/** A tool advertised to the model (OpenAI function-calling shape). */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema object describing the tool parameters. */
  parameters: Record<string, unknown>;
}

/** Events streamed out of a provider during a single completion. */
export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "unknown";

export function normalizeFinishReason(reason: unknown): FinishReason {
  switch (reason) {
    case "stop": case "tool_calls": case "length": case "content_filter": return reason;
    default: return "unknown";
  }
}

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-calls"; calls: ToolCallRequest[] }
  | { type: "done"; finishReason: FinishReason; rawFinishReason?: string | null };

export interface StreamChatParams {
  messages: ChatMessage[];
  tools: ToolSchema[];
  signal: AbortSignal;
}

/**
 * A provider failure that carries a localized, actionable message for the
 * end user (`userMessage`) alongside the raw SDK message (`message`, used for
 * logs/diagnostics). Providers should throw this instead of a bare `Error`
 * whenever they can name the likely cause (bad key, low balance, rate limit,
 * …) — the harness has no backend-specific knowledge and just displays
 * `userMessage` when present.
 */
export class ProviderError extends Error {
  readonly userMessage: string;

  constructor(message: string, userMessage: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderError";
    this.userMessage = userMessage;
  }
}

export interface LLMProvider {
  readonly model: string;

  /**
   * Output budget sent as `max_tokens` for this model (per-model override wins
   * over the global value). Surfaced so the harness can name the actual limit
   * when it reports a truncation.
   */
  readonly maxTokens?: number;

  /**
   * `prompt_tokens` the backend reported for the most recent request, when it
   * returns usage at all. Used only to calibrate the local prompt-size estimate
   * (see `harness/context.ts`).
   */
  readonly lastPromptTokens?: number | null;

  /**
   * Full usage record from the most recent request that reported one (e.g.
   * `prompt_tokens`, `completion_tokens`, `prompt_cache_hit_tokens`,
   * `prompt_cache_miss_tokens`). Providers that never see usage leave this
   * `null`. Surfaced so the harness can log cache-hit ratio without every
   * caller re-deriving it from raw chunks.
   */
  readonly lastUsage?: Record<string, number> | null;
  /**
   * Stream a single assistant completion. Implementations must:
   *  - yield `text-delta` for visible content as it arrives,
   *  - yield `reasoning-delta` for reasoning/thinking tokens if the backend exposes them,
   *  - yield a single `tool-calls` event (if any tool calls were produced),
   *  - yield a final `done` event with the finish reason.
   */
  streamChat(params: StreamChatParams): AsyncIterable<StreamEvent>;
}
