import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeHistory } from "../../src/harness/loop.js";
import type { ChatMessage } from "../../src/llm/types.js";

const UNKNOWN = /结果未知/;
const NEVER_RAN = /未执行.*可以安全重试/;

function call(id: string) {
  return { id, name: "bash", arguments: "{}" };
}

describe("sanitizeHistory", () => {
  it("leaves a consistent history untouched", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      { role: "assistant", content: null, tool_calls: [call("a"), call("b")] },
      { role: "tool", tool_call_id: "b", content: "rb" },
      { role: "tool", tool_call_id: "a", content: "ra" },
      { role: "assistant", content: "done" },
    ];
    const out = sanitizeHistory(messages);
    assert.equal(out.length, messages.length);
    out.forEach((m, i) => assert.equal(m, messages[i]));
  });

  it("answers unanswered tool_calls right after their assistant message", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [call("a"), call("b")] },
      { role: "tool", tool_call_id: "a", content: "ra" },
      { role: "user", content: "继续" },
    ];
    const out = sanitizeHistory(messages);
    assert.deepEqual(out.map((m) => [m.role, m.tool_call_id]), [
      ["assistant", undefined],
      ["tool", "a"],
      ["tool", "b"],
      ["user", undefined],
    ]);
  });

  it("closes a trailing open group (crash after the assistant message)", () => {
    const out = sanitizeHistory([{ role: "assistant", content: null, tool_calls: [call("x")] }]);
    assert.equal(out.length, 2);
    assert.equal(out[1]!.tool_call_id, "x");
    assert.match(out[1]!.content!, UNKNOWN);
  });

  it("drops orphan and duplicate tool messages", () => {
    const out = sanitizeHistory([
      { role: "user", content: "u" },
      { role: "tool", tool_call_id: "ghost", content: "orphan" },
      { role: "assistant", content: null, tool_calls: [call("a")] },
      { role: "tool", tool_call_id: "a", content: "ra" },
      { role: "tool", tool_call_id: "a", content: "dup" },
    ]);
    assert.deepEqual(out.map((m) => m.content), ["u", null, "ra"]);
  });

  it("does not let a tool message answer an earlier assistant's call", () => {
    const out = sanitizeHistory([
      { role: "assistant", content: null, tool_calls: [call("a")] },
      { role: "assistant", content: null, tool_calls: [call("b")] },
      { role: "tool", tool_call_id: "a", content: "late" },
      { role: "tool", tool_call_id: "b", content: "rb" },
    ]);
    assert.deepEqual(out.map((m) => [m.role, m.tool_call_id ?? null]), [
      ["assistant", null],
      ["tool", "a"],
      ["assistant", null],
      ["tool", "b"],
    ]);
    assert.match(out[1]!.content!, UNKNOWN);
  });

  it("uses tool_started evidence to tell 'may have run' from 'never ran'", () => {
    const out = sanitizeHistory(
      [{ role: "assistant", content: null, tool_calls: [call("ran"), call("queued")] }],
      new Set(["ran"]),
    );
    assert.match(out[1]!.content!, UNKNOWN);
    assert.match(out[2]!.content!, NEVER_RAN);
  });

  it("stays conservative when there is no evidence at all", () => {
    const out = sanitizeHistory([{ role: "assistant", content: null, tool_calls: [call("q")] }], new Set());
    assert.match(out[1]!.content!, UNKNOWN);
  });

  it("does not mutate its input", () => {
    const messages: ChatMessage[] = [{ role: "assistant", content: null, tool_calls: [call("a")] }];
    sanitizeHistory(messages);
    assert.equal(messages.length, 1);
  });
});
