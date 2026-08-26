import OpenAI from "openai";
import type { ProviderConfig } from "../config.js";
import { logger } from "../logger.js";
import type {
  ChatMessage,
  LLMProvider,
  StreamChatParams,
  StreamEvent,
  ToolCallRequest,
} from "./types.js";

/**
 * OpenAI-compatible provider.
 *
 * Works against any endpoint that speaks the `/chat/completions` API: OpenAI,
 * DeepSeek, Groq, OpenRouter, Together, Ollama (`/v1`), LM Studio, vLLM, etc.
 * The endpoint, key and model all come from JSON config.
 */
export class OpenAIProvider implements LLMProvider {
  readonly model: string;
  readonly #client: OpenAI;
  readonly #temperature: number;
  readonly #maxTokens: number;
  readonly #requestTimeoutMs: number;

  constructor(cfg: ProviderConfig) {
    this.model = cfg.model;
    this.#temperature = cfg.temperature;
    this.#maxTokens = cfg.maxTokens;
    this.#requestTimeoutMs = cfg.requestTimeoutMs;
    this.#client = new OpenAI({
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey ?? "unused",
      defaultHeaders: cfg.extraHeaders,
      timeout: this.#requestTimeoutMs,
    });
  }

  async *streamChat({ messages, tools, signal }: StreamChatParams): AsyncIterable<StreamEvent> {
    const startedAt = Date.now();
    let firstChunkAt: number | null = null;
    logger.info(`LLM request start model=${this.model} messages=${messages.length} tools=${tools.length}`);
    const request: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIMessages(messages),
      temperature: this.#temperature,
      max_tokens: this.#maxTokens,
      stream: true,
    };
    if (tools.length > 0) {
      request.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      request.tool_choice = "auto";
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = (await this.#client.chat.completions.create(request as any, {
      signal,
    })) as unknown as AsyncIterable<any>;

    // Accumulate streamed tool calls, keyed by their delta index.
    const acc = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | null = null;

    for await (const chunk of stream) {
      if (firstChunkAt === null) {
        firstChunkAt = Date.now();
        logger.info(`LLM first chunk model=${this.model} waitMs=${firstChunkAt - startedAt}`);
      }
      const choice = chunk?.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};

      if (typeof delta.content === "string" && delta.content.length > 0) {
        yield { type: "text-delta", text: delta.content };
      }

      // Some OpenAI-compatible backends expose reasoning tokens.
      const reasoning: unknown = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        yield { type: "reasoning-delta", text: reasoning };
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx: number = typeof tc.index === "number" ? tc.index : 0;
          let entry = acc.get(idx);
          if (!entry) {
            entry = { id: "", name: "", args: "" };
            acc.set(idx, entry);
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    logger.info(
      `LLM request end model=${this.model} elapsedMs=${Date.now() - startedAt} ` +
        `firstChunkMs=${firstChunkAt === null ? "none" : firstChunkAt - startedAt} finishReason=${finishReason ?? "none"}`,
    );

    if (acc.size > 0) {
      const calls: ToolCallRequest[] = [...acc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, e], i) => ({
          id: e.id || `call_${i}`,
          name: e.name,
          arguments: e.args || "{}",
        }));
      yield { type: "tool-calls", calls };
    }

    yield { type: "done", finishReason };
  }
}

/** Map our neutral ChatMessage[] to the OpenAI chat-completions message shape. */
function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant") {
      const out: Record<string, unknown> = { role: "assistant" };
      if (m.tool_calls?.length) {
        out.content = m.content ?? null;
        out.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        }));
      } else {
        out.content = m.content ?? "";
      }
      return out;
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.tool_call_id, content: m.content ?? "" };
    }
    return { role: m.role, content: m.content ?? "" };
  });
}
