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
export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-calls"; calls: ToolCallRequest[] }
  | { type: "done"; finishReason: string | null };

export interface StreamChatParams {
  messages: ChatMessage[];
  tools: ToolSchema[];
  signal: AbortSignal;
}

export interface LLMProvider {
  readonly model: string;
  /**
   * Stream a single assistant completion. Implementations must:
   *  - yield `text-delta` for visible content as it arrives,
   *  - yield `reasoning-delta` for reasoning/thinking tokens if the backend exposes them,
   *  - yield a single `tool-calls` event (if any tool calls were produced),
   *  - yield a final `done` event with the finish reason.
   */
  streamChat(params: StreamChatParams): AsyncIterable<StreamEvent>;
}
