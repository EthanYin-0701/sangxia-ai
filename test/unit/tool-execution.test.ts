import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { AgentConfig } from "../../src/config.js";
import { runTurn } from "../../src/harness/loop.js";
import { ToolRegistry, type Tool } from "../../src/harness/tool.js";
import type { LLMProvider, StreamChatParams, StreamEvent } from "../../src/llm/types.js";
import { Session } from "../../src/session.js";
import { bashTool } from "../../src/tools/bash.js";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "sangxia-unit-"));
  process.env.SANGXIA_SESSION_DIR = dir;
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** Scripted provider: one call to `name` with `args`, then a final answer. */
class OneCallProvider implements LLMProvider {
  readonly model = "scripted";
  calls = 0;
  constructor(private readonly name: string, private readonly args: Record<string, unknown>) {}
  async *streamChat(_params: StreamChatParams): AsyncIterable<StreamEvent> {
    if (this.calls++ === 0) {
      yield { type: "tool-calls", calls: [{ id: "call_1", name: this.name, arguments: JSON.stringify(this.args) }] };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text-delta", text: "ok" };
    yield { type: "done", finishReason: "stop" };
  }
}

const config: AgentConfig = { maxIterations: 5, historyWarningMessages: 400, toolTimeoutMs: 300_000, permissionMode: "auto", systemPrompt: null };
const conn = { sessionUpdate: async () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) } as unknown as AgentSideConnection;

async function run(tool: Tool, args: Record<string, unknown>, controller = new AbortController()) {
  const session = new Session(`unit-exec-${Math.random().toString(36).slice(2)}`, dir, [], { readTextFile: false, writeTextFile: false, terminal: false }, "auto", "scripted");
  session.messages.push({ role: "system", content: "s" }, { role: "user", content: "u" });
  const stop = await runTurn({ conn, session, provider: new OneCallProvider(tool.name, args), tools: new ToolRegistry([tool]), config, signal: controller.signal });
  const result = session.messages.find((m) => m.role === "tool" && m.tool_call_id === "call_1");
  return { stop, result: result?.content ?? "" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function slowTool(extra: Partial<Tool> = {}): Tool {
  return {
    name: "mcp__browser__wait",
    description: "d",
    kind: "other",
    needsPermission: false,
    parameters: { type: "object", properties: { timeout: { type: "number", description: "seconds" } } },
    title: () => "wait",
    run: async () => {
      await sleep(50);
      return { output: "waited" };
    },
    ...extra,
  };
}

describe("harness tool deadline (SA-24)", () => {
  it("does not treat an arbitrary tool's `timeout` argument as a millisecond deadline", async () => {
    const { stop, result } = await run(slowTool(), { timeout: 1 }); // "1 second" for the MCP tool
    assert.equal(stop, "end_turn");
    assert.equal(result, "waited");
  });

  it("still honours a deadline the tool derives from its own arguments", async () => {
    const tool = slowTool({ name: "bash_like", timeoutFromArgs: (a: { timeout?: unknown }) => Number(a.timeout) });
    const { result } = await run(tool, { timeout: 5 });
    assert.match(result, /超时（5ms）/);
  });

  it("bash declares its own millisecond `timeout`; non-numbers fall back to the default", () => {
    assert.equal(bashTool.timeoutFromArgs?.({ command: "x", timeout: 30_000 }), 30_000);
    assert.equal(bashTool.timeoutFromArgs?.({ command: "x", timeout: "60" }), undefined);
    assert.equal(bashTool.timeoutFromArgs?.({ command: "x" }), undefined);
  });
});

describe("cancel after dispatch (SA-29)", () => {
  it("reports the result as unknown, not as never executed", async () => {
    const controller = new AbortController();
    const tool = slowTool({
      run: async () => {
        controller.abort(); // user cancels while the side effect is in flight
        await sleep(10);
        return { output: "done" };
      },
    });
    const { stop, result } = await run(tool, {}, controller);
    assert.equal(stop, "cancelled");
    assert.match(result, /结果未知/);
    assert.match(result, /核实/);
    assert.doesNotMatch(result, /未执行/);
  });
});
