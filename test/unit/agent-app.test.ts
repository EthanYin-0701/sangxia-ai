import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  type ClientContext,
  type ContentBlock,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  RequestError,
  type SessionNotification,
  client,
  methods,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { serveAgent } from "../../src/acp/agent-app.js";
import { SangxiaAgent } from "../../src/agent.js";
import type { Config } from "../../src/config.js";
import type { LLMProvider, StreamChatParams, StreamEvent } from "../../src/llm/types.js";
import { logger } from "../../src/logger.js";

// SA-65 Step B: the SDK 2.7.0 `agent()` routing layer, driven over a real
// NDJSON byte stream by an SDK `client()` app (the same path an editor uses).

let dir: string;
let logFile: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "sangxia-agent-app-"));
  process.env.SANGXIA_SESSION_DIR = join(dir, "sessions");
  // Project memory present, so the first prompt runs no initialization turn.
  writeFileSync(join(dir, "AGENTS.md"), "# Test project");
  mkdirSync(join(dir, ".sangxia"));
  writeFileSync(join(dir, ".sangxia/memory.md"), "# Memory");
  logFile = join(dir, "agent.log");
  logger.configure({ file: logFile, stderr: false });
});
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => writeFileSync(logFile, ""));

function makeConfig(permissionMode: "auto" | "confirm"): Config {
  return {
    provider: {
      type: "mock",
      model: "model-a",
      models: [
        { modelId: "model-a", name: "A" },
        { modelId: "model-b", name: "B" },
      ],
    },
    agent: { maxIterations: 5, historyWarningMessages: 400, toolTimeoutMs: 300_000, permissionMode, systemPrompt: null },
    mcp: { enabled: false, connectTimeoutMs: 1000 },
    skills: { enabled: false, dirs: [] },
    hooks: { enabled: false },
  } as unknown as Config;
}

interface PendingPermission {
  params: RequestPermissionRequest;
  respond(r: RequestPermissionResponse): void;
}

/** Agent served over an in-memory NDJSON pair, plus an SDK client app driving it. */
function connect(permissionMode: "auto" | "confirm" = "auto") {
  const a = new PassThrough(); // client → agent
  const b = new PassThrough(); // agent → client
  const { agent, connection } = serveAgent(
    ndJsonStream(Writable.toWeb(b), Readable.toWeb(a)),
    (channel) => new SangxiaAgent(channel, makeConfig(permissionMode)),
  );
  const updates: SessionNotification[] = [];
  const permissions: PendingPermission[] = [];
  let onPermission: (() => void) | null = null;
  const clientConnection = client()
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params);
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) =>
      new Promise<RequestPermissionResponse>((respond) => {
        permissions.push({ params, respond });
        onPermission?.();
      }))
    .connect(ndJsonStream(Writable.toWeb(a), Readable.toWeb(b)));
  const ctx: ClientContext = clientConnection.agent;
  return {
    agent,
    ctx,
    updates,
    permissions,
    /** Resolves once the agent has an unanswered permission request out. */
    nextPermission: () => new Promise<void>((resolve) => {
      onPermission = () => { onPermission = null; resolve(); };
    }),
    async initialize() {
      // Advertise terminal-auth support so the agent returns its terminal auth
      // methods (SA-58 gates them on this capability).
      return ctx.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { auth: { terminal: true } },
      });
    },
    async newSession() {
      await this.initialize();
      return ctx.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
    },
    async close() {
      clientConnection.close();
      connection.close();
      await agent.shutdown();
    },
  };
}

async function rejectsWithCode(p: Promise<unknown>, code: number) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof RequestError, `expected RequestError, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    return true;
  });
}

/** Every assistant `tool_calls` entry has a matching `tool` message (invariant 2). */
function assertToolCallsAnswered(agent: SangxiaAgent, sessionId: string) {
  const messages = agent.getSession(sessionId)!.messages;
  const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  const calls = messages.flatMap((m) => m.tool_calls ?? []);
  assert.ok(calls.length > 0, "the turn made at least one tool call");
  for (const call of calls) assert.ok(answered.has(call.id), `tool call ${call.id} has a tool result`);
}

/** Provider that streams one chunk, then hangs until the turn is aborted. */
class HangingProvider implements LLMProvider {
  readonly model = "hanging";
  started!: Promise<void>;
  #markStarted!: () => void;
  constructor() {
    this.started = new Promise((resolve) => { this.#markStarted = resolve; });
  }
  async *streamChat(params: StreamChatParams): AsyncIterable<StreamEvent> {
    yield { type: "text-delta", text: "思考中" };
    this.#markStarted();
    await new Promise<void>((resolve) => {
      if (params.signal.aborted) resolve();
      else params.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    yield { type: "done", finishReason: "unknown" };
  }
}

function useProvider(agent: SangxiaAgent, provider: LLMProvider) {
  (agent as unknown as { providerFor(id: string): LLMProvider }).providerFor = () => provider;
}

describe("agent() routing (SA-65 Step B)", () => {
  it("requires initialize before any other request (2.7.0 connection gate)", async () => {
    const c = connect();
    try {
      await rejectsWithCode(c.ctx.request(methods.agent.session.new, { cwd: dir, mcpServers: [] }), -32600);
      const init = await c.initialize();
      assert.equal(init.protocolVersion, PROTOCOL_VERSION);
      assert.ok(init.authMethods?.length, "auth methods are still advertised");
    } finally {
      await c.close();
    }
  });

  it("still sends the legacy `models` field next to configOptions on session/new", async () => {
    const c = connect();
    try {
      const res = (await c.newSession()) as Awaited<ReturnType<typeof c.newSession>> & { models?: { currentModelId: string } };
      assert.equal(res.models?.currentModelId, "model-a");
      assert.equal(res.configOptions?.find((o) => o.id === "model")?.currentValue, "model-a");
    } finally {
      await c.close();
    }
  });

  it("routes `session/set_model` (dropped from the 2.7.0 schema) and keeps -32602 semantics", async () => {
    const c = connect();
    try {
      const { sessionId } = await c.newSession();
      assert.deepEqual(await c.ctx.request("session/set_model", { sessionId, modelId: "model-b" }), {});
      assert.equal(c.agent.getSession(sessionId)!.modelId, "model-b");
      assert.equal(c.updates.at(-1)?.update.sessionUpdate, "config_option_update");
      await rejectsWithCode(c.ctx.request("session/set_model", { sessionId, modelId: "nope" }), -32602);
      await rejectsWithCode(c.ctx.request("session/set_model", null), -32602);
      await rejectsWithCode(c.ctx.request("session/set_model", { sessionId }), -32602);
      assert.equal(c.agent.getSession(sessionId)!.modelId, "model-b");
    } finally {
      await c.close();
    }
  });

  it("routes `_sangxia.set_model` through the fallback and reports unknown methods as -32601", async () => {
    const c = connect();
    try {
      const { sessionId } = await c.newSession();
      assert.deepEqual(await c.ctx.request("_sangxia.set_model", { sessionId, modelId: "model-b" }), {});
      assert.equal(c.agent.getSession(sessionId)!.modelId, "model-b");
      await rejectsWithCode(c.ctx.request("_sangxia.set_model", []), -32602);
      await assert.rejects(c.ctx.request("_custom.thing", {}), (e: unknown) => {
        assert.ok(e instanceof RequestError);
        assert.equal(e.code, -32601);
        assert.deepEqual(e.data, { method: "_custom.thing" });
        return true;
      });
    } finally {
      await c.close();
    }
  });

  it("leaves unimplemented stable methods (session/close, session/list) at -32601", async () => {
    const c = connect();
    try {
      await c.initialize();
      await rejectsWithCode(c.ctx.request(methods.agent.session.list, {}), -32601);
      await rejectsWithCode(c.ctx.request(methods.agent.logout, {}), -32601);
    } finally {
      await c.close();
    }
  });

  it("switches mode and model through session/set_config_option", async () => {
    const c = connect();
    try {
      const { sessionId } = await c.newSession();
      const res = await c.ctx.request(methods.agent.session.setConfigOption, { sessionId, configId: "mode", value: "confirm" });
      assert.equal(res.configOptions.find((o) => o.id === "mode")?.currentValue, "confirm");
      await rejectsWithCode(
        c.ctx.request(methods.agent.session.setConfigOption, { sessionId, configId: "model", type: "boolean", value: true }),
        -32602,
      );
    } finally {
      await c.close();
    }
  });
});

describe("handler error logging (SA-65 #5, now at the router)", () => {
  it("logs an unexpected handler failure with its stack and answers -32603", async () => {
    const c = connect();
    try {
      await c.initialize();
      c.agent.newSession = async () => { throw new TypeError("boom"); };
      await rejectsWithCode(c.ctx.request(methods.agent.session.new, { cwd: dir, mcpServers: [] }), -32603);
      const log = readFileSync(logFile, "utf8");
      assert.match(log, /\[ERROR\] ACP session\/new 处理失败: TypeError: boom/);
      assert.match(log, /at /, "stack trace is logged");
    } finally {
      await c.close();
    }
  });

  it("logs a RequestError once at warn, routed to the request's session (internal calls don't double-log)", async () => {
    const c = connect();
    try {
      const { sessionId } = await c.newSession();
      writeFileSync(logFile, "");
      await rejectsWithCode(
        c.ctx.request(methods.agent.session.setConfigOption, { sessionId, configId: "model", value: "nope" }),
        -32602,
      );
      const lines = readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes("ACP "));
      assert.equal(lines.length, 1, `exactly one entry-level log line, got:\n${lines.join("\n")}`);
      assert.match(lines[0]!, new RegExp(`\\[WARN\\] \\[session=${sessionId}\\] ACP session/set_config_option 返回错误 -32602`));
    } finally {
      await c.close();
    }
  });

  it("names the extension method in the log line", async () => {
    const c = connect();
    try {
      await c.initialize();
      await assert.rejects(c.ctx.request("_custom.thing", {}));
      assert.match(readFileSync(logFile, "utf8"), /ACP _custom\.thing 返回错误 -32601/);
    } finally {
      await c.close();
    }
  });
});

describe("protocol-level cancellation (SA-65 Step B #2)", () => {
  const prompt = (sessionId: string): ContentBlock[] => [{ type: "text", text: `create hello.txt ${sessionId}` }];

  it("session/cancel during a permission wait → cancelled, tool calls answered, next prompt works", async () => {
    const c = connect("confirm");
    try {
      const { sessionId } = await c.newSession();
      const asked = c.nextPermission();
      const turn = c.ctx.request(methods.agent.session.prompt, { sessionId, prompt: prompt(sessionId) });
      await asked;
      await c.ctx.notify(methods.agent.session.cancel, { sessionId });
      assert.equal((await turn).stopReason, "cancelled");
      assertToolCallsAnswered(c.agent, sessionId);
      // The client settles its now-stale permission request, as ACP requires on cancel.
      c.permissions.shift()!.respond({ outcome: { outcome: "cancelled" } });

      await c.ctx.request(methods.agent.session.setConfigOption, { sessionId, configId: "mode", value: "auto" });
      const next = await c.ctx.request(methods.agent.session.prompt, { sessionId, prompt: prompt(sessionId) });
      assert.equal(next.stopReason, "end_turn");
    } finally {
      await c.close();
    }
  });

  it("$/cancel_request on session/prompt during a permission wait reaches session.abort", async () => {
    const c = connect("confirm");
    try {
      const { sessionId } = await c.newSession();
      const asked = c.nextPermission();
      const cancel = new AbortController();
      const turn = c.ctx.request(
        methods.agent.session.prompt,
        { sessionId, prompt: prompt(sessionId) },
        { cancellationSignal: cancel.signal },
      );
      await asked;
      cancel.abort();
      // Without the ctx.signal → session.abort cascade this would hang on the
      // unanswered permission request forever.
      assert.equal((await turn).stopReason, "cancelled");
      assertToolCallsAnswered(c.agent, sessionId);
      const session = c.agent.getSession(sessionId)!;
      assert.equal(session.promptInFlight, false);
      assert.equal(session.abort, null);
      assert.match(readFileSync(join(dir, "sessions", `${sessionId}.jsonl`), "utf8"), /"tool_call_id":"call_write_1"/);
    } finally {
      await c.close();
    }
  });

  it("$/cancel_request while the LLM is streaming stops the stream, and the session keeps working", async () => {
    const c = connect();
    try {
      const { sessionId } = await c.newSession();
      const hanging = new HangingProvider();
      useProvider(c.agent, hanging);
      const cancel = new AbortController();
      const turn = c.ctx.request(
        methods.agent.session.prompt,
        { sessionId, prompt: [{ type: "text", text: "hi" }] },
        { cancellationSignal: cancel.signal },
      );
      await hanging.started;
      cancel.abort();
      assert.equal((await turn).stopReason, "cancelled");

      const answered = new HangingProvider();
      useProvider(c.agent, answered);
      const second = c.ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "again" }] });
      await answered.started;
      await c.ctx.notify(methods.agent.session.cancel, { sessionId });
      assert.equal((await second).stopReason, "cancelled", "a cancelled request does not leave the session wedged");
    } finally {
      await c.close();
    }
  });
});
