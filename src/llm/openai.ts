import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
import type { ProviderConfig } from "../config.js";
import { logger } from "../logger.js";
import { normalizeFinishReason } from "./types.js";
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
  readonly #idleTimeoutMs: number;
  readonly #totalTimeoutMs: number;
  readonly #includeUsage: boolean;
  readonly #retries: number;
  readonly #retryBaseDelayMs: number;
  #lastPromptTokens: number | null = null;
  #lastUsage: Record<string, number> | null = null;

  constructor(cfg: ProviderConfig) {
    this.model = cfg.model;
    this.#temperature = cfg.temperature;
    const modelConfig = cfg.models?.find((m) => m.modelId === cfg.model);
    this.#maxTokens = modelConfig?.maxTokens ?? cfg.maxTokens;
    this.#requestTimeoutMs = cfg.requestTimeoutMs;
    this.#idleTimeoutMs = modelConfig?.streamIdleTimeoutMs ?? cfg.streamIdleTimeoutMs;
    this.#totalTimeoutMs = modelConfig?.streamTotalTimeoutMs ?? cfg.streamTotalTimeoutMs;
    this.#includeUsage = cfg.streamIncludeUsage;
    this.#retries = modelConfig?.streamRetries ?? cfg.streamRetries ?? 2;
    this.#retryBaseDelayMs = modelConfig?.streamRetryBaseDelayMs ?? cfg.streamRetryBaseDelayMs ?? 500;
    this.#client = new OpenAI({
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey ?? "unused",
      defaultHeaders: cfg.extraHeaders,
      timeout: this.#requestTimeoutMs,
      maxRetries: 0,
    });
  }

  /**
   * Stream one completion, retrying failures that happened **before the first
   * delta** (nothing streamed yet → no visible duplicates, no side effects).
   *
   * Deliberately not retried:
   *  - user cancellation (`signal.aborted`),
   *  - our own idle/total watchdogs (retrying would multiply the wait),
   *  - anything after a delta was yielded (a retry would repeat output),
   *  - non-transient errors (4xx other than 408/409/429).
   */
  async *streamChat(params: StreamChatParams): AsyncIterable<StreamEvent> {
    const { signal } = params;
    for (let attempt = 1; ; attempt++) {
      const state: AttemptState = { yieldedAnything: false };
      try {
        yield* this.#attemptStream(params, state, attempt);
        return;
      } catch (error) {
        const reason = signal.aborted ? (signal.reason ?? new Error("aborted")) : null;
        if (reason) throw reason;
        if (error instanceof StreamTimeoutError) throw error;
        if (state.yieldedAnything || attempt > this.#retries || !isRetryable(error)) throw error;
        const delayMs = retryDelayMs(error, attempt, this.#retryBaseDelayMs);
        logger.warn(
          `LLM retry model=${this.model} nextAttempt=${attempt + 1}/${this.#retries + 1} ` +
            `reason=${describeError(error)} delayMs=${delayMs}`,
        );
        await sleep(delayMs, signal);
      }
    }
  }

  get lastPromptTokens(): number | null {
    return this.#lastPromptTokens;
  }

  get lastUsage(): Record<string, number> | null {
    return this.#lastUsage;
  }

  get maxTokens(): number {
    return this.#maxTokens;
  }

  async *#attemptStream(
    { messages, tools, signal }: StreamChatParams,
    state: AttemptState,
    attempt: number,
  ): AsyncIterable<StreamEvent> {
    const startedAt = Date.now();
    let firstChunkAt: number | null = null;
    let lastChunkAt: number | null = null;
    let firstTextAt: number | null = null;
    let chunks = 0, contentChars = 0, reasoningChars = 0, toolArgumentChars = 0;
    let usage: Record<string, number> | undefined;
    let finishReason: string | null = null;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const totalTimer = setTimeout(() => controller.abort(new StreamTimeoutError("total", this.#totalTimeoutMs)), this.#totalTimeoutMs);
    let idleTimer: ReturnType<typeof setTimeout>;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new StreamTimeoutError("idle", this.#idleTimeoutMs)), this.#idleTimeoutMs);
    };
    resetIdle();
    try {
      controller.signal.throwIfAborted();
      logger.info(`LLM request start model=${this.model} messages=${messages.length} tools=${tools.length}`);
      const request: Record<string, unknown> = {
        model: this.model,
        messages: toOpenAIMessages(messages),
        temperature: this.#temperature,
        max_tokens: this.#maxTokens,
        stream: true,
      };
      if (this.#includeUsage) request.stream_options = { include_usage: true };
      if (tools.length > 0) {
        request.tools = tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        request.tool_choice = "auto";
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = (await this.#client.chat.completions.create(request as any, {
        signal: controller.signal,
      })) as unknown as AsyncIterable<any>;

      // Accumulate streamed tool calls, keyed by their delta index.
      const acc = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
        controller.signal.throwIfAborted();
        resetIdle();
        lastChunkAt = Date.now();
        chunks++;
        if (chunk.usage) {
          usage = {};
          for (const key of [
            "prompt_tokens",
            "completion_tokens",
            "total_tokens",
            "prompt_cache_hit_tokens",
            "prompt_cache_miss_tokens",
          ]) {
            if (typeof chunk.usage[key] === "number") usage[key] = chunk.usage[key];
          }
          const reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens;
          if (typeof reasoningTokens === "number") usage.reasoning_tokens = reasoningTokens;
          // DeepSeek names the hit count directly; other OpenAI-compatible
          // backends expose the same number as `prompt_tokens_details.cached_tokens`.
          const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
          if (usage.prompt_cache_hit_tokens === undefined && typeof cachedTokens === "number") {
            usage.prompt_cache_hit_tokens = cachedTokens;
          }
          if (typeof usage.prompt_tokens === "number") this.#lastPromptTokens = usage.prompt_tokens;
          this.#lastUsage = usage;
        }
        if (firstChunkAt === null) {
          firstChunkAt = Date.now();
          logger.info(`LLM first chunk model=${this.model} waitMs=${firstChunkAt - startedAt}`);
        }
        const choice = chunk?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};

        if (typeof delta.content === "string" && delta.content.length > 0) {
          contentChars += delta.content.length;
          firstTextAt ??= Date.now();
          state.yieldedAnything = true;
          yield { type: "text-delta", text: delta.content };
        }

        // Some OpenAI-compatible backends expose reasoning tokens.
        const reasoning: unknown = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === "string" && reasoning.length > 0) {
          reasoningChars += reasoning.length;
          state.yieldedAnything = true;
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
            if (typeof tc.function?.arguments === "string") {
              entry.args += tc.function.arguments;
              toolArgumentChars += tc.function.arguments.length;
            }
          }
        }

        if (choice.finish_reason) finishReason = choice.finish_reason;
      }

      controller.signal.throwIfAborted();

      if (acc.size > 0) {
        state.yieldedAnything = true;
        const calls: ToolCallRequest[] = [...acc.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, e], i) => ({
            id: e.id || `call_${i}`,
            name: e.name,
            arguments: e.args,
          }));
        yield { type: "tool-calls", calls };
      }

      yield { type: "done", finishReason: normalizeFinishReason(finishReason), rawFinishReason: finishReason };
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(totalTimer);
      clearTimeout(idleTimer!);
      signal.removeEventListener("abort", onAbort);
      controller.abort();
      logger.info(`LLM request end model=${this.model} attempt=${attempt} elapsedMs=${Date.now() - startedAt} ` +
        `firstChunkMs=${firstChunkAt === null ? "none" : firstChunkAt - startedAt} ` +
        `firstTextMs=${firstTextAt === null ? "none" : firstTextAt - startedAt} ` +
        `lastChunkMs=${lastChunkAt === null ? "none" : lastChunkAt - startedAt} ` +
        `chunks=${chunks} contentChars=${contentChars} reasoningChars=${reasoningChars} ` +
        `toolArgumentChars=${toolArgumentChars} finishReason=${JSON.stringify(finishReason)} usage=${JSON.stringify(usage)}`);
    }
  }
}

export class StreamTimeoutError extends Error {
  constructor(readonly kind: "idle" | "total", timeoutMs: number) {
    super(`模型流${kind === "idle" ? "空闲" : "总时长"}超时 (${timeoutMs}ms)`);
    this.name = "StreamTimeoutError";
  }
}

/** Per-attempt bookkeeping used to decide whether a retry is still safe. */
interface AttemptState {
  /** Whether this attempt already yielded text/reasoning/tool-calls. */
  yieldedAnything: boolean;
}

/** Retryable: transient transport failures and the usual "try again" statuses. */
function isRetryable(error: unknown): boolean {
  if (error instanceof APIUserAbortError) return false;
  if (error instanceof APIConnectionTimeoutError || error instanceof APIConnectionError) return true;
  if (error instanceof APIError) {
    const status = error.status;
    if (status === undefined) return true; // no HTTP response (transport-level)
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  // Unknown error types (e.g. our own abort) are not retried.
  return false;
}

/** Exponential backoff, honoring `Retry-After` (seconds or HTTP date). */
function retryDelayMs(error: unknown, attempt: number, baseDelayMs: number): number {
  const retryAfter = parseRetryAfter(error);
  if (retryAfter !== null) return Math.min(retryAfter, 30_000);
  return Math.min(baseDelayMs * 2 ** (attempt - 1), 8_000);
}

function parseRetryAfter(error: unknown): number | null {
  if (!(error instanceof APIError)) return null;
  const headers = error.headers;
  // The SDK passes a Fetch `Headers` instance; tolerate plain objects too.
  const header =
    typeof (headers as Headers | undefined)?.get === "function"
      ? (headers as Headers).get("retry-after")
      : (headers as Record<string, string> | undefined)?.["retry-after"];
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function describeError(error: unknown): string {
  const name = error instanceof Error ? (error.constructor?.name ?? error.name) : typeof error;
  if (error instanceof APIError) {
    return `${name}${error.status === undefined ? "" : ` status=${error.status}`}`;
  }
  return name;
}

/** Abortable sleep — Ctrl+C must not wait out the backoff. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
