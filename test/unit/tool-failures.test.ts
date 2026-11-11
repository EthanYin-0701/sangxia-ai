import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentConfig } from "../../src/config.js";
import type { HookRegistry } from "../../src/hooks/index.js";
import { emptyOutcome, type HookOutcome } from "../../src/hooks/types.js";
import { runTurn } from "../../src/harness/loop.js";
import { ToolRegistry, type Tool } from "../../src/harness/tool.js";
import type { LLMProvider, StreamChatParams, StreamEvent } from "../../src/llm/types.js";
import { sessionPath } from "../../src/persistence.js";
import { Session, type PermissionMode } from "../../src/session.js";
import { fetchUrlTool } from "../../src/tools/fetch-url.js";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "sangxia-fail-"));
  process.env.SANGXIA_SESSION_DIR = dir;
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** One raw tool call (arguments as given, so invalid JSON is possible), then a final answer. */
class OneCallProvider implements LLMProvider {
  readonly model = "scripted";
  calls = 0;
  constructor(private readonly name: string, private readonly rawArgs: string) {}
  async *streamChat(_params: StreamChatParams): AsyncIterable<StreamEvent> {
    if (this.calls++ === 0) {
      yield { type: "tool-calls", calls: [{ id: "call_1", name: this.name, arguments: this.rawArgs }] };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text-delta", text: "ok" };
    yield { type: "done", finishReason: "stop" };
  }
}

const config: AgentConfig = { maxIterations: 5, historyWarningMessages: 400, toolTimeoutMs: 300_000, permissionMode: "auto", systemPrompt: null };

function fakeHooks(pre: () => HookOutcome | Promise<HookOutcome>): HookRegistry {
  return {
    has: (event: string) => event === "pre_tool_use",
    run: async () => pre(),
  } as unknown as HookRegistry;
}

function echoTool(extra: Partial<Tool> = {}): Tool {
  return {
    name: "echo",
    description: "d",
    kind: "edit",
    needsPermission: false,
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    title: (a: { text?: string }) => `echo ${a.text}`,
    run: async (a: { text: string }) => ({ output: a.text }),
    ...extra,
  };
}

interface Scenario {
  tool?: Tool;
  name?: string;
  rawArgs?: string;
  mode?: PermissionMode;
  hooks?: HookRegistry;
  controller?: AbortController;
  permission?: () => Promise<unknown>;
  prepare?: (session: Session) => void;
}

async function run(s: Scenario) {
  const updates: SessionNotification["update"][] = [];
  let permissionRequests = 0;
  const conn = {
    sessionUpdate: async (n: SessionNotification) => {
      updates.push(n.update);
    },
    requestPermission: async () => {
      permissionRequests++;
      return s.permission ? s.permission() : { outcome: { outcome: "selected", optionId: "reject_once" } };
    },
  } as unknown as AgentSideConnection;
  const tool = s.tool ?? echoTool();
  const session = new Session(`unit-fail-${Math.random().toString(36).slice(2)}`, dir, [], { readTextFile: false, writeTextFile: false, terminal: false }, s.mode ?? "auto", "scripted");
  session.messages.push({ role: "system", content: "s" }, { role: "user", content: "u" });
  s.prepare?.(session);
  const stop = await runTurn({
    conn,
    session,
    provider: new OneCallProvider(s.name ?? tool.name, s.rawArgs ?? '{"text":"hi"}'),
    tools: new ToolRegistry([tool]),
    config,
    signal: (s.controller ?? new AbortController()).signal,
    ...(s.hooks ? { hooks: s.hooks } : {}),
  });
  const toolMessages = session.messages.filter((m) => m.role === "tool" && m.tool_call_id === "call_1");
  const events = readFileSync(sessionPath(session.id), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { t: string; toolCallId?: string; status?: string });
  const started = events.filter((e) => e.t === "tool_started" && e.toolCallId === "call_1");
  const finished = events.filter((e) => e.t === "tool_finished" && e.toolCallId === "call_1");
  const mine = updates.filter((u) => "toolCallId" in u && u.toolCallId === "call_1");
  return { stop, toolMessages, started, finished, updates: mine, permissionRequests };
}

/** The invariants every failure path must keep (SA-9). */
function assertFailedOnce(r: Awaited<ReturnType<typeof run>>, expected: RegExp, opts: { dispatched: boolean }) {
  assert.equal(r.toolMessages.length, 1, "exactly one tool message answers the tool_call");
  assert.match(String(r.toolMessages[0]!.content), expected);
  assert.equal(r.started.length, opts.dispatched ? 1 : 0, "tool_started iff dispatched");
  assert.equal(r.finished.length, r.started.length, "every tool_started has a tool_finished");
  if (opts.dispatched) assert.equal(r.finished[0]!.status, "failed");
  const last = r.updates.at(-1) as { status?: string } | undefined;
  assert.equal(last?.status, "failed", "client sees the call as failed");
}

describe("executeToolCall failure paths (SA-9)", () => {
  it("invalid JSON arguments", async () => {
    const r = await run({ rawArgs: "{not json" });
    assert.equal(r.stop, "end_turn");
    assertFailedOnce(r, /^Error: 工具参数不是合法 JSON/, { dispatched: false });
    assert.equal(r.updates.length, 1);
  });

  it("schema-invalid arguments", async () => {
    const r = await run({ rawArgs: '{"text":1}' });
    assertFailedOnce(r, /^Error: /, { dispatched: false });
  });

  it("unknown tool", async () => {
    const r = await run({ name: "nope", rawArgs: "{}" });
    assertFailedOnce(r, /^Error: 未知工具 nope/, { dispatched: false });
    const announced = r.updates[0] as { sessionUpdate: string; title?: string };
    assert.equal(announced.sessionUpdate, "tool_call");
    assert.equal(announced.title, "未知工具 nope");
  });

  it("pre_tool_use hook denies", async () => {
    const r = await run({ hooks: fakeHooks(() => ({ ...emptyOutcome(), decision: "deny", hookName: "guard", reason: "no" })) });
    assertFailedOnce(r, /^Error: 被 hook guard 拒绝：no/, { dispatched: false });
    const shown = r.updates[0] as { content?: { content: { text: string } }[] };
    assert.equal(shown.content?.[0]?.content.text, r.toolMessages[0]!.content, "client shows the model's text (D13)");
  });

  it("pre_tool_use hook rewrites to invalid input", async () => {
    const r = await run({ hooks: fakeHooks(() => ({ ...emptyOutcome(), hookName: "rw", updatedInput: { text: 42 } })) });
    assertFailedOnce(r, /hook "rw" 改写的参数不合法/, { dispatched: false });
  });

  it("permission denied", async () => {
    const r = await run({ tool: echoTool({ needsPermission: true }), mode: "confirm" });
    assert.equal(r.permissionRequests, 1);
    assertFailedOnce(r, /^Error: 用户拒绝执行此工具/, { dispatched: false });
  });

  it("permission request throws", async () => {
    const r = await run({
      tool: echoTool({ needsPermission: true }),
      mode: "confirm",
      permission: async () => {
        throw new Error("connection lost");
      },
    });
    assertFailedOnce(r, /^Error: 用户拒绝执行此工具/, { dispatched: false });
  });

  it("tool times out", async () => {
    const r = await run({ tool: echoTool({ timeoutMs: 5, run: () => new Promise(() => {}) }) });
    assertFailedOnce(r, /^Error: 工具执行超时（5ms）/, { dispatched: true });
  });

  it("tool throws", async () => {
    const r = await run({
      tool: echoTool({
        run: async () => {
          throw new Error("boom");
        },
      }),
    });
    assertFailedOnce(r, /^Error: boom/, { dispatched: true });
  });

  it("turn cancelled while the tool runs", async () => {
    const controller = new AbortController();
    const r = await run({
      controller,
      tool: echoTool({
        run: async () => {
          controller.abort(); // user cancels while the side effect is in flight
          await new Promise((r) => setTimeout(r, 10));
          return { output: "late" };
        },
      }),
    });
    assert.equal(r.stop, "cancelled");
    assertFailedOnce(r, /结果未知/, { dispatched: true });
  });

  it("a hook runner that throws still answers the tool_call instead of sinking the turn", async () => {
    const r = await run({
      hooks: fakeHooks(() => {
        throw new Error("hook runner crashed");
      }),
    });
    assert.equal(r.stop, "end_turn");
    assertFailedOnce(r, /^Error: hook runner crashed/, { dispatched: false });
  });

  it("success path is unchanged", async () => {
    const r = await run({});
    assert.equal(r.toolMessages.length, 1);
    assert.equal(r.toolMessages[0]!.content, "hi");
    assert.equal(r.finished[0]?.status, "completed");
  });
});

describe("fetch_url to an internal address in auto mode (SA-27)", () => {
  it("asks for permission even though permissionMode is auto", async () => {
    let fetched = false;
    const tool: Tool = {
      ...fetchUrlTool,
      run: async () => {
        fetched = true;
        return { output: "creds" };
      },
    };
    const r = await run({ tool, mode: "auto", rawArgs: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data/" }) });
    assert.equal(r.permissionRequests, 1, "auto mode must not silently fetch cloud metadata");
    assert.equal(fetched, false);
    assertFailedOnce(r, /用户拒绝/, { dispatched: false });
  });

  it("an earlier 'always allow' for that origin does not count", async () => {
    let fetched = false;
    const tool: Tool = {
      ...fetchUrlTool,
      run: async () => {
        fetched = true;
        return { output: "local" };
      },
    };
    const r = await run({
      tool,
      mode: "auto",
      rawArgs: JSON.stringify({ url: "http://localhost:11434/api/tags" }),
      prepare: (session) => session.permissions.set("fetch_url:origin:http://localhost:11434", "allow"),
    });
    assert.equal(r.permissionRequests, 1, "remembered allow is ignored for internal targets");
    assert.equal(fetched, false);
  });
});
