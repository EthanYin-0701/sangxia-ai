import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentSideConnection, RequestPermissionRequest, SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentConfig } from "../../src/config.js";
import { runTurn } from "../../src/harness/loop.js";
import { ToolRegistry } from "../../src/harness/tool.js";
import type { LLMProvider, StreamChatParams, StreamEvent } from "../../src/llm/types.js";
import { Session } from "../../src/session.js";
import { askUserTool } from "../../src/tools/ask-user.js";

let dir: string;
before(() => {
  // runTurn persists every mutation; keep it out of ~/.config.
  dir = mkdtempSync(join(tmpdir(), "sangxia-unit-"));
  process.env.SANGXIA_SESSION_DIR = dir;
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** Scripted provider: one `ask_user` call, then a final answer quoting the tool result. */
class ScriptedProvider implements LLMProvider {
  readonly model = "scripted";
  seen: StreamChatParams["messages"][] = [];
  async *streamChat(params: StreamChatParams): AsyncIterable<StreamEvent> {
    this.seen.push(structuredClone(params.messages));
    if (this.seen.length === 1) {
      yield {
        type: "tool-calls",
        calls: [{
          id: "call_ask",
          name: "ask_user",
          arguments: JSON.stringify({ question: "继续吗？", options: [{ label: "继续" }, { label: "停止" }] }),
        }],
      };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text-delta", text: "好的" };
    yield { type: "done", finishReason: "stop" };
  }
}

describe("ask_user inside a turn", () => {
  it("attaches the question to the announced tool call and feeds the answer back", async () => {
    const updates: SessionNotification[] = [];
    const permissions: RequestPermissionRequest[] = [];
    const conn = {
      sessionUpdate: async (n: SessionNotification) => void updates.push(n),
      requestPermission: async (req: RequestPermissionRequest) => {
        permissions.push(req);
        return { outcome: { outcome: "selected", optionId: "choice_0" } };
      },
    } as unknown as AgentSideConnection;
    const session = new Session("unit-ask-user", dir, [], { readTextFile: false, writeTextFile: false, terminal: false }, "confirm", "scripted");
    session.messages.push({ role: "system", content: "s" }, { role: "user", content: "u" });
    const provider = new ScriptedProvider();
    const config: AgentConfig = { maxIterations: 5, historyWarningMessages: 400, toolTimeoutMs: 300_000, permissionMode: "confirm", systemPrompt: null };

    const stop = await runTurn({ conn, session, provider, tools: new ToolRegistry([askUserTool]), config, signal: new AbortController().signal });

    assert.equal(stop, "end_turn");
    // Exactly one prompt: the question itself, not an extra "allow ask_user?" gate.
    assert.equal(permissions.length, 1);
    assert.equal(permissions[0]!.toolCall.toolCallId, "call_ask");
    const announced = updates.find((u) => u.update.sessionUpdate === "tool_call" && u.update.toolCallId === "call_ask");
    assert.ok(announced, "tool call announced before asking");
    const tool = provider.seen[1]!.find((m) => m.role === "tool");
    assert.deepEqual(tool, { role: "tool", tool_call_id: "call_ask", content: "用户的回答：继续" });
  });
});
