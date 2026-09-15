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
   * Stream a single assistant completion. Implementations must:
   *  - yield `text-delta` for visible content as it arrives,
   *  - yield `reasoning-delta` for reasoning/thinking tokens if the backend exposes them,
   *  - yield a single `tool-calls` event (if any tool calls were produced),
   *  - yield a final `done` event with the finish reason.
   */
  streamChat(params: StreamChatParams): AsyncIterable<StreamEvent>;
}
