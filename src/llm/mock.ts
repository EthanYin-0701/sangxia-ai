import type { LLMProvider, StreamChatParams, StreamEvent } from "./types.js";

/**
 * Offline mock provider for end-to-end tests (no network, no API key).
 *
 * It ignores the real conversation and instead plays a fixed 3-step script that
 * exercises the full harness: a permission-gated write, a read, then a final
 * answer with no tool calls (→ `end_turn`).
 */
export class MockProvider implements LLMProvider {
  readonly model = "mock";
  #step = 0;

  async *streamChat(_params: StreamChatParams): AsyncIterable<StreamEvent> {
    this.#step += 1;

    if (this.#step === 1) {
      for (const ch of "好的，我先创建一个文件。") yield { type: "text-delta", text: ch };
      yield {
        type: "tool-calls",
        calls: [
          {
            id: "call_write_1",
            name: "write_file",
            arguments: JSON.stringify({ path: "hello.txt", content: "hello from zhente\n" }),
          },
        ],
      };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }

    if (this.#step === 2) {
      for (const ch of "现在把它读回来确认。") yield { type: "text-delta", text: ch };
      yield {
        type: "tool-calls",
        calls: [{ id: "call_read_1", name: "read_file", arguments: JSON.stringify({ path: "hello.txt" }) }],
      };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }

    for (const ch of "完成：已创建 hello.txt 并确认内容。") yield { type: "text-delta", text: ch };
    yield { type: "done", finishReason: "stop" };
  }
}
