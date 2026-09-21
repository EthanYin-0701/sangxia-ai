// Offline regression coverage for truncated/empty streams and unsafe tool calls.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@zed-industries/agent-client-protocol";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runTurn, sanitizeHistory } from "../dist/harness/loop.js";
import { ToolRegistry } from "../dist/harness/tool.js";
import { Session } from "../dist/session.js";
import { OpenAIProvider, StreamTimeoutError } from "../dist/llm/openai.js";
import { fsTools } from "../dist/tools/fs-tools.js";
import { connectMcpServer } from "../dist/mcp/client.js";
import { logger } from "../dist/logger.js";
import { validateToolArguments } from "../dist/harness/validation.js";
import { ZhenTeAgent } from "../dist/agent.js";
import { createHeadTailBuffer, truncateMiddle, truncationMarker } from "../dist/harness/truncate.js";
import { bashTool } from "../dist/tools/bash.js";
import { appendEvent, loadSession } from "../dist/persistence.js";

const dir = await mkdtemp(join(tmpdir(), "zhente-reliability-"));
process.env.ZHENTE_SESSION_DIR = join(dir, "sessions");
logger.configure({ stderr: false, dir: join(dir, "logs") });
let rounds = [], requests = [], closed = 0;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const part of req) body += part;
  requests.push(JSON.parse(body));
  const round = rounds.shift();
  let interval;
  res.on("close", () => { closed++; clearInterval(interval); });
  const send = (delta, finish_reason) => res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`);
  if (round === "fail500") { res.writeHead(500, { "content-type": "text/plain" }).end("boom"); return; }
  if (round === "rate-limit") { res.writeHead(429, { "content-type": "text/plain", "retry-after": "1" }).end("slow down"); return; }
  if (round === "insufficient-balance") {
    res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Insufficient Balance", type: "invalid_request_error" } }));
    return;
  }
  if (round === "bad-key") {
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Invalid API Key" } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.flushHeaders();
  if (round === "idle") return;
  if (round === "one-chunk-then-silent") {
    // Emits exactly one chunk (so firstChunkTimer is satisfied), then the
    // connection just sits open — only the *idle* watchdog can catch this.
    send({ content: "x" });
    return;
  }
  if (round === "keep-alive-then-answer") {
    // Mimics a busy DeepSeek endpoint: raw SSE comment lines while queueing
    // (the openai SDK drops these before they'd ever become a `chunk`), then
    // a normal answer once "inference starts".
    interval = setInterval(() => res.write(": keep-alive\n\n"), 15);
    setTimeout(() => {
      clearInterval(interval);
      send({ content: "完成" });
      send({}, "stop");
      res.end("data: [DONE]\n\n");
    }, 150);
    return;
  }
  if (round === "reasoning-forever") {
    interval = setInterval(() => send({ reasoning_content: "private reasoning" }), 10);
    return;
  }
  if (round === "midfail") {
    send({ content: "半段" });
    setTimeout(() => res.destroy(), 20);
    return;
  }
  for (const delta of round?.deltas ?? []) send(delta);
  send({}, round?.finish ?? "stop");
  if (round?.usage) res.write(`data: ${JSON.stringify({ choices: [], usage: round.usage })}\n\n`);
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const cfg = {
  type: "openai", baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test",
  model: "test", temperature: 0, maxTokens: 100, requestTimeoutMs: 2000,
  firstChunkTimeoutMs: 5000, streamIdleTimeoutMs: 1000, streamTotalTimeoutMs: 2000, streamIncludeUsage: true,
};
const finish = (reason, deltas = []) => ({ finish: reason, deltas });
const callDelta = (name, args, id = "call-test") => ({ tool_calls: [{ index: 0, id, function: { name, arguments: args } }] });
const answer = finish("stop", [{ content: "完成" }]);
const caps = { readTextFile: false, writeTextFile: false, terminal: false };
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.error(`✓ ${name}`); }

async function turn(sequence, { toolList = [], permission, config = {}, setup } = {}) {
  rounds = [...sequence]; requests = [];
  const session = new Session(randomUUID(), dir, [], caps, "confirm", "test");
  session.messages = [{ role: "user", content: "test" }];
  session.abort = new AbortController();
  const updates = [];
  let permissions = 0;
  const conn = {
    async sessionUpdate(p) { updates.push(p.update); },
    async requestPermission() {
      permissions++;
      if (permission) return permission(session);
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
    },
  };
  setup?.(session);
  const stopReason = await runTurn({ conn, session, provider: new OpenAIProvider(cfg),
    tools: new ToolRegistry(toolList), signal: session.abort.signal,
    config: { maxIterations: 5, historyWarningMessages: 3, permissionMode: "confirm", systemPrompt: null, ...config },
  });
  assert.deepEqual(sanitizeHistory(session.messages), session.messages, "history must remain paired");
  const saved = await loadSession(session.id).catch(() => null);
  if (saved) {
    assert.deepEqual(saved.messages, JSON.parse(JSON.stringify(session.messages)));
    // M2: mid-turn checkpoints must carry the full field set (model/permission).
    assert.equal(saved.modelId, "test");
    assert.equal(saved.permissionMode, "confirm");
  }
  return { session, stopReason, permissions, updates,
    text: updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("") };
}

try {
  await check("length / partial text / reasoning-only map to max_tokens", async () => {
    for (const deltas of [[], [{ content: "半截" }], [{ reasoning_content: "private reasoning" }]]) {
      const r = await turn([finish("length", deltas)]);
      assert.equal(r.stopReason, "max_tokens");
      assert.match(r.text, /输出被截断/);
      assert.match(r.text, /maxTokens=100/, "notice must name the actual budget");
      assert.match(r.text, /思考过程 \+ 正文 \+ 工具参数/, "notice must explain what shares the budget");
      if (deltas[0]?.content) assert.match(r.text, /^半截/);
      assert.equal(requests.length, 1);
    }
  });
  await check("filtered and unknown/missing finish reasons refuse without tools", async () => {
    for (const reason of ["content_filter", "vendor-unknown", ""]) {
      const r = await turn([finish(reason)]);
      assert.equal(r.stopReason, "refusal");
    }
  });
  await check("empty stop recovers once with a generic prompt", async () => {
    const reasoning = finish("stop", [{ reasoning_content: "private reasoning" }]);
    const ok = await turn([reasoning, answer]);
    assert.equal(ok.stopReason, "end_turn");
    // The recovery prompt is in the request; an unrelated notice may follow it.
    assert.ok(requests[1].messages.some((m) => /上次响应未产生正文/.test(m.content ?? "")), "recovery prompt must reach the model");
    // reasoning_content must be echoed back (DeepSeek thinking mode 400s
    // otherwise), attached to the assistant turn that produced it, not leaked
    // into visible content.
    const reasoningTurn = requests[1].messages.find((m) => m.role === "assistant" && m.reasoning_content);
    assert.equal(reasoningTurn?.reasoning_content, "private reasoning");
    assert.equal(reasoningTurn?.content, "", "no tool_calls on this turn → content coerces to empty string, not leaking reasoning into it");
    const empty = await turn([reasoning, reasoning, answer]);
    assert.equal(empty.stopReason, "refusal");
    assert.equal(requests.length, 2);
    assert.match(empty.text, /模型响应为空/);
  });
  const write = fsTools.find((t) => t.name === "write_file");
  let executed = 0;
  const guardedWrite = { ...write, run: async () => { executed++; return { output: "ok" }; } };
  await check("malformed/non-object/schema-invalid built-in args never request permission", async () => {
    for (const args of ['{"path":', "", "null", "[]", '"value"', "42", "{}", '{"path":3,"content":"x"}']) {
      const r = await turn([finish("tool_calls", [callDelta(write.name, args)]), answer], { toolList: [guardedWrite] });
      assert.equal(r.permissions, 0);
      assert.match(r.session.messages.find((m) => m.role === "tool").content, /^Error:/);
    }
    assert.equal(executed, 0);
    const r = await turn([finish("tool_calls", [callDelta(write.name, '{"path":"x","content":"y"}')]), answer], { toolList: [guardedWrite] });
    assert.equal(r.permissions, 1);
    assert.equal(executed, 1);
  });
  const reasoningWrite = { ...write, run: async () => ({ output: "ok" }) };
  await check("reasoning_content on a tool-call turn is persisted and echoed back, and survives reload", async () => {
    const planned = finish("tool_calls", [{ reasoning_content: "先看文件再改" }, callDelta(write.name, '{"path":"x","content":"y"}')]);
    const r = await turn([planned, answer], { toolList: [reasoningWrite] });
    assert.equal(r.stopReason, "end_turn");
    const assistantTurn = r.session.messages.find((m) => m.role === "assistant" && m.tool_calls);
    assert.equal(assistantTurn.reasoning_content, "先看文件再改");

    const followUp = requests[1].messages.find((m) => m.role === "assistant" && m.tool_calls);
    assert.equal(followUp.reasoning_content, "先看文件再改", "must be echoed back on the next request");

    const saved = await loadSession(r.session.id);
    assert.equal(saved.messages.find((m) => m.role === "assistant" && m.tool_calls).reasoning_content, "先看文件再改", "must survive a reload");
  });
  await check("passBackReasoning: none suppresses the echo for non-DeepSeek backends", async () => {
    const { OpenAIProvider } = await import("../dist/llm/openai.js");
    const planned = finish("tool_calls", [{ reasoning_content: "先看文件再改" }, callDelta(write.name, '{"path":"x","content":"y"}')]);
    rounds = [planned, answer];
    requests = [];
    const session = new Session(randomUUID(), dir, [], caps, "confirm", "test");
    session.messages = [{ role: "user", content: "test" }];
    session.abort = new AbortController();
    const stopReason = await runTurn({
      conn: { async sessionUpdate() {} }, session, provider: new OpenAIProvider({ ...cfg, passBackReasoning: "none" }),
      tools: new ToolRegistry([reasoningWrite]), signal: session.abort.signal,
      config: { maxIterations: 5, historyWarningMessages: 3, permissionMode: "auto", systemPrompt: null },
    });
    assert.equal(stopReason, "end_turn");
    // Still captured in our own history …
    assert.equal(session.messages.find((m) => m.role === "assistant" && m.tool_calls).reasoning_content, "先看文件再改");
    // … but never sent to the backend.
    const followUp = requests[1].messages.find((m) => m.role === "assistant" && m.tool_calls);
    assert.equal(followUp.reasoning_content, undefined);
  });
  await check("length refuses even syntactically complete tool calls", async () => {
    const r = await turn([finish("length", [callDelta(write.name, '{"path":"x","content":"y"}')])], { toolList: [guardedWrite] });
    assert.equal(r.stopReason, "max_tokens");
    assert.equal(r.permissions, 0);
    assert.equal(executed, 1);
  });
  await check("real MCP schema uses the same permission-before-execution guard", async () => {
    const mcp = await connectMcpServer({ name: "mock", command: process.execPath,
      args: [new URL("./mock-mcp-server.mjs", import.meta.url).pathname], env: [] }, 2000);
    try {
      const tool = mcp.tools[0];
      let calls = 0;
      const guarded = { ...tool, run: async (...args) => { calls++; return tool.run(...args); } };
      const r = await turn([finish("tool_calls", [callDelta(tool.name, '{"text":7}')]), answer], { toolList: [guarded] });
      assert.equal(r.permissions, 0);
      assert.equal(calls, 0);
      assert.match(r.session.messages.find((m) => m.role === "tool").content, /Schema/);
    } finally { await mcp.close(); }
  });
  await check("Schema dialects, nested refs and invalid schemas fail safely", async () => {
    for (const dialect of ["http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft/2019-09/schema", "https://json-schema.org/draft/2020-12/schema"]) {
      const tool = { ...guardedWrite, parameters: {
        $schema: dialect, type: "object", required: ["items"], additionalProperties: false,
        definitions: { item: { type: "integer", minimum: 1 } },
        properties: { items: { type: "array", items: { $ref: "#/definitions/item" } } },
      } };
      assert.equal(validateToolArguments(tool, { items: [1, 2] }), null);
      assert.match(validateToolArguments(tool, { items: ["1"] }), /Schema/);
      assert.match(validateToolArguments(tool, { items: [0] }), /Schema/);
      assert.match(validateToolArguments(tool, { items: [1], extra: true }), /Schema/);
    }
    assert.match(validateToolArguments({ ...guardedWrite, parameters: { type: "made-up" } }, {}), /Schema/);
  });
  await check("body examples stay text and do not trigger recovery", async () => {
    const example = '```json\n{"tool":"write_file"}\n``` <function_call>example</function_call>';
    const r = await turn([finish("stop", [{ content: example }])], { toolList: [guardedWrite] });
    assert.equal(r.stopReason, "end_turn");
    assert.equal(r.text, example);
    assert.equal(r.permissions, 0);
    assert.equal(requests.length, 1);
  });
  await check("interrupted history is repaired as 'result unknown', turn-cancel stays 'not executed'", async () => {
    // Cross-restart repair (H1①): the tool may have completed before the process died.
    const orphan = [{ role: "assistant", content: null, tool_calls: [{ id: "call_x", name: "bash", arguments: "{}" }] }];
    const repaired = sanitizeHistory(orphan);
    assert.equal(repaired.length, 2);
    assert.match(repaired[1].content, /结果未知/);
    assert.match(repaired[1].content, /核实/);
    // H1②: with a persisted `tool_started` the wording is unchanged …
    assert.match(sanitizeHistory(orphan, new Set(["call_x"]))[1].content, /结果未知/);
    // … and without one the call provably never ran, so it is safe to retry.
    const neverRan = sanitizeHistory(orphan, new Set(["call_other"]));
    assert.match(neverRan[1].content, /未执行/);
    assert.match(neverRan[1].content, /可以安全重试/);
    assert.ok(!neverRan[1].content.includes("结果未知"));

    // In-turn cancel (loop.ts remaining-calls path): those calls truly never ran.
    const abortingWrite = { ...write, run: async (_args, { session }) => { session.abort.abort(); return { output: "ok" }; } };
    const twoCalls = { finish: "tool_calls", deltas: [
      { tool_calls: [{ index: 0, id: "call-a", function: { name: "write_file", arguments: '{"path":"a","content":"x"}' } }] },
      { tool_calls: [{ index: 1, id: "call-b", function: { name: "write_file", arguments: '{"path":"b","content":"x"}' } }] },
    ] };
    const r = await turn([twoCalls], { toolList: [abortingWrite] });
    assert.equal(r.stopReason, "cancelled");
    const placeholder = r.session.messages.find((m) => m.role === "tool" && m.tool_call_id === "call-b");
    assert.match(placeholder.content, /未执行/);
    assert.ok(!placeholder.content.includes("结果未知"), "in-turn cancel wording must differ from cross-restart repair");
  });
  await check("JSONL event log round-trips history, mode/model and started tool calls", async () => {
    const localWrite = { ...write, run: async () => ({ output: "ok" }) }; // don't touch the shared `executed` counter
    const r = await turn([finish("tool_calls", [callDelta("write_file", '{"path":"x","content":"y"}', "call_1")]), answer],
      { toolList: [localWrite] });
    assert.equal(r.stopReason, "end_turn");
    const raw = await readFile(join(dir, "sessions", `${r.session.id}.jsonl`), "utf8");
    const events = raw.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(events[0].t, "meta");
    assert.equal(events[0].version, 2);
    assert.equal(events[0].cwd, dir);
    assert.equal(events[0].modelId, "test");
    assert.equal(events[0].permissionMode, "confirm");
    assert.deepEqual(events.filter((e) => e.t === "tool_started").map((e) => e.toolCallId), ["call_1"]);
    assert.deepEqual(events.filter((e) => e.t === "tool_finished").map((e) => e.status), ["completed"]);
    // `tool_started` must precede the result, and the run must precede the finish.
    assert.ok(events.findIndex((e) => e.t === "tool_started") < events.findIndex((e) => e.t === "tool_finished"));
    // No snapshot rewrite: message events are appended once, exactly mirroring history.
    assert.equal(events.filter((e) => e.t === "message").length, r.session.messages.length);
    const { readdir } = await import("node:fs/promises");
    assert.equal((await readdir(join(dir, "sessions"))).filter((f) => f.includes(".tmp-")).length, 0, "no tmp+rename snapshot writes");

    const loaded = await loadSession(r.session.id);
    assert.deepEqual(loaded.messages, JSON.parse(JSON.stringify(r.session.messages)));
    assert.equal(loaded.modelId, "test");
    assert.equal(loaded.permissionMode, "confirm");
    assert.deepEqual([...loaded.startedToolCalls], ["call_1"]);
    // A repaired history is replayed as a replacement, not doubled.
    assert.deepEqual(
      sanitizeHistory(loaded.messages, loaded.startedToolCalls),
      JSON.parse(JSON.stringify(r.session.messages)),
    );
  });
  await check("a crash during a tool leaves retry-safe vs unknown distinguishable", async () => {
    // Simulate a run killed mid-tool: the log has the assistant message, a
    // `tool_started` event and no result.
    const id = randomUUID();
    await appendEvent(id, { t: "meta", version: 2, sessionId: id, cwd: dir, permissionMode: "confirm", modelId: "test", createdAt: new Date().toISOString() });
    await appendEvent(id, { t: "message", message: { role: "user", content: "go" } });
    await appendEvent(id, { t: "message", message: { role: "assistant", content: null, tool_calls: [{ id: "started_1", name: "bash", arguments: "{}" }] } });
    await appendEvent(id, { t: "tool_started", toolCallId: "started_1", name: "bash", at: new Date().toISOString() });
    const loaded = await loadSession(id);
    const repaired = sanitizeHistory(loaded.messages, loaded.startedToolCalls);
    assert.match(repaired.at(-1).content, /结果未知/);
    assert.ok(!repaired.at(-1).content.includes("安全重试"));
  });
  await check("a truncated tail line is ignored, corruption in the middle is skipped", async () => {
    const r = await turn([answer]);
    const path = join(dir, "sessions", `${r.session.id}.jsonl`);
    const good = await readFile(path, "utf8");
    await writeFile(path, `${good}{"t":"message","mess`, "utf8"); // half-written final line
    const loaded = await loadSession(r.session.id);
    assert.deepEqual(loaded.messages, JSON.parse(JSON.stringify(r.session.messages)));

    const lines = good.trim().split("\n");
    await writeFile(path, `${lines[0]}\nNOT JSON\n${lines.slice(1).join("\n")}\n`, "utf8");
    const loaded2 = await loadSession(r.session.id);
    assert.deepEqual(loaded2.messages, JSON.parse(JSON.stringify(r.session.messages)));
  });
  await check("legacy JSON snapshots are migrated to JSONL on first read", async () => {
    const id = randomUUID();
    const legacy = {
      version: 1, sessionId: id, cwd: dir, permissionMode: "auto", modelId: "test",
      updatedAt: new Date().toISOString(),
      messages: [{ role: "user", content: "old" }, { role: "assistant", content: "old answer" }],
    };
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(join(dir, "sessions", `${id}.json`), JSON.stringify(legacy), "utf8");
    const loaded = await loadSession(id);
    assert.deepEqual(loaded.messages, legacy.messages);
    assert.equal(loaded.permissionMode, "auto");
    assert.equal(loaded.modelId, "test");
    assert.equal(loaded.startedToolCalls.size, 0, "legacy logs carry no started evidence");
    // Migrated in place: JSONL exists, the old snapshot is gone, content is equivalent.
    const migrated = await readFile(join(dir, "sessions", `${id}.jsonl`), "utf8");
    const events = migrated.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(events[0].t, "meta");
    assert.equal(events.filter((e) => e.t === "message").length, 2);
    await assert.rejects(() => readFile(join(dir, "sessions", `${id}.json`), "utf8"));
    assert.equal((await loadSession(id)).messages.length, 2);
  });
  await check("appending a turn does not rewrite the whole log", async () => {
    const r = await turn([answer]);
    let lines = (await readFile(join(dir, "sessions", `${r.session.id}.jsonl`), "utf8")).trim().split("\n").length;
    // A second turn on the same session only appends its own new events.
    rounds = [answer];
    await runTurn({ conn: { async sessionUpdate() {} }, session: r.session, provider: new OpenAIProvider(cfg),
      tools: new ToolRegistry([]), signal: new AbortController().signal,
      config: { maxIterations: 5, historyWarningMessages: 400, toolTimeoutMs: 300_000, permissionMode: "confirm", systemPrompt: null } });
    const raw = await readFile(join(dir, "sessions", `${r.session.id}.jsonl`), "utf8");
    const events = raw.trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(events.length > lines, "second turn must append");
    assert.equal(events.filter((e) => e.t === "message").length, r.session.messages.length,
      "history must not be re-appended (O(n²) write amplification)");
  });
  await check("isError results get a model-visible prefix, idempotently", async () => {
    const boom = { ...guardedWrite, run: async () => ({ output: "boom", isError: true }) };
    const r = await turn([finish("tool_calls", [callDelta("write_file", '{"path":"x","content":"y"}')]), answer], { toolList: [boom] });
    const tool = r.session.messages.find((m) => m.role === "tool");
    assert.match(tool.content, /^\[工具执行失败\] /);
    assert.match(tool.content, /boom/);
    // The client sees exactly the same text.
    const update = r.updates.find((u) => u.sessionUpdate === "tool_call_update");
    assert.equal(update.content[0].content.text, tool.content);

    const prefixed = { ...guardedWrite, run: async () => ({ output: "Error: 已存在", isError: true }) };
    const r2 = await turn([finish("tool_calls", [callDelta("write_file", '{"path":"x","content":"y"}')]), answer], { toolList: [prefixed] });
    assert.equal(r2.session.messages.find((m) => m.role === "tool").content, "Error: 已存在");

    const already = { ...guardedWrite, run: async () => ({ output: "[工具执行失败] 又一次", isError: true }) };
    const r3 = await turn([finish("tool_calls", [callDelta("write_file", '{"path":"x","content":"y"}')]), answer], { toolList: [already] });
    assert.equal(r3.session.messages.find((m) => m.role === "tool").content, "[工具执行失败] 又一次");
  });
  await check("a second prompt is rejected while one is in flight, and the turn still cancels", async () => {
    const agentConfig = {
      provider: cfg,
      agent: { maxIterations: 5, historyWarningMessages: 3, permissionMode: "confirm", systemPrompt: null },
      mcp: { enabled: false, connectTimeoutMs: 1000 },
      skills: { enabled: false, dirs: [] },
      hooks: { enabled: false },
    };
    const agent = new ZhenTeAgent({
      async sessionUpdate() {},
      async requestPermission() { return { outcome: { outcome: "cancelled" } }; },
    }, agentConfig);
    await agent.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await agent.newSession({ cwd: dir, mcpServers: [] });
    try {
      // "idle" never finishes the response, so turn #1 stays in flight.
      rounds = ["idle"]; requests = [];
      const pending = agent.prompt({ sessionId, prompt: [{ type: "text", text: "first" }] });
      for (let i = 0; i < 200 && requests.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(requests.length, 1, "first prompt must have started");

      await assert.rejects(
        () => agent.prompt({ sessionId, prompt: [{ type: "text", text: "second" }] }),
        (e) => /在运行中/.test(e?.data?.sessionId ?? ""),
      );
      assert.equal(requests.length, 1, "rejected prompt must not reach the provider");

      await agent.cancel({ sessionId });
      assert.equal((await pending).stopReason, "cancelled");

      // The claim is released, not a one-shot lock.
      rounds = [answer];
      assert.equal((await agent.prompt({ sessionId, prompt: [{ type: "text", text: "third" }] })).stopReason, "end_turn");
    } finally {
      await agent.shutdown();
    }
  });
  await check("truncation keeps head and tail, never splits surrogate pairs", async () => {
    const hasLoneSurrogate = (s) => {
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          if (!(i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff)) return true;
          i++;
        } else if (c >= 0xdc00 && c <= 0xdfff) return true;
      }
      return false;
    };
    for (const [text, limit] of [
      [`${"A".repeat(100)}MIDDLE${"B".repeat(100)}`, 40],
      [`${"😀".repeat(60)}tail`, 25],
      [`head${"中".repeat(60)}`, 25],
    ]) {
      const out = truncateMiddle(text, limit);
      assert.ok(out.includes("已省略中间"), "must carry the shared marker");
      assert.ok(out.length <= limit + truncationMarker(0, 0).length + 12, `length bound: ${out.length}`);
      assert.ok(!hasLoneSurrogate(out), "must not split a surrogate pair");
      assert.equal(out.slice(0, 1), text.slice(0, 1));
      assert.equal(out.slice(-1), text.slice(-1));
    }
    assert.equal(truncateMiddle("short", 40), "short", "short output unchanged");
    // Streaming buffer: same marker, keeps the tail.
    const buffer = createHeadTailBuffer(100);
    for (let i = 0; i < 40; i++) buffer.push(`chunk-${i}-`);
    assert.ok(buffer.dropped() > 0);
    assert.match(buffer.text(), /^chunk-0-/);
    assert.match(buffer.text(), /chunk-39-$/);
    assert.match(buffer.text(), /已省略中间/);
    const small = createHeadTailBuffer(100);
    small.push("tiny");
    assert.equal(small.text(), "tiny");
    assert.equal(small.dropped(), 0);
  });
  await check("oversized tool output reaches the model head and tail", async () => {
    const big = `<<HEAD>>${"A".repeat(150_000)}<<TAIL>>`;
    const bigTool = { ...guardedWrite, run: async () => ({ output: big }) };
    const r = await turn([finish("tool_calls", [callDelta("write_file", '{"path":"x","content":"y"}')]), answer], { toolList: [bigTool] });
    const content = r.session.messages.find((m) => m.role === "tool").content;
    assert.match(content, /<<HEAD>>/);
    assert.match(content, /<<TAIL>>/);
    assert.match(content, /已省略中间/);
    assert.ok(content.length < big.length);
  });
  await check("local bash fallback keeps the tail of a huge output", async () => {
    const session = new Session(randomUUID(), dir, [], caps, "confirm", "test");
    const command = `node -e "process.stdout.write('A'.repeat(1200000));process.stdout.write('<<TAIL>>')"`;
    const result = await bashTool.run({ command }, { conn: {}, session, signal: new AbortController().signal });
    assert.match(result.output, /<<TAIL>>/);
    assert.match(result.output, /已省略中间/);
    assert.ok(result.raw.droppedBytes > 0);
  });
  await check("mid-turn checkpoints preserve the selected model", async () => {
    const agentConfig = {
      provider: { ...cfg, models: [{ modelId: "test", name: "Test" }, { modelId: "other", name: "Other" }] },
      agent: { maxIterations: 5, historyWarningMessages: 3, permissionMode: "confirm", systemPrompt: null },
      mcp: { enabled: false, connectTimeoutMs: 1000 },
      skills: { enabled: false, dirs: [] },
      hooks: { enabled: false },
    };
    const agent = new ZhenTeAgent({
      async sessionUpdate() {},
      async requestPermission() { return { outcome: { outcome: "cancelled" } }; },
    }, agentConfig);
    await agent.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await agent.newSession({ cwd: dir, mcpServers: [] });
    try {
      await agent.setSessionModel({ sessionId, modelId: "other" });
      // A turn that hits the mid-turn checkpoint (tool call → result) must not
      // revert the persisted model to the config default.
      const planArgs = JSON.stringify({ plan: [{ content: "x", status: "pending", priority: "high" }] });
      rounds = [finish("tool_calls", [callDelta("update_plan", planArgs)]), answer];
      assert.equal((await agent.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] })).stopReason, "end_turn");
      const saved = await loadSession(sessionId);
      assert.equal(saved.modelId, "other");
      // loadSession also restores it.
      const { models, modes } = await agent.loadSession({ sessionId, cwd: dir, mcpServers: [] });
      assert.equal(models.currentModelId, "other");
      assert.equal(modes.currentModeId, "confirm");
    } finally {
      await agent.shutdown();
    }
  });
  await check("large-history warning is visible to the user and the model, once per session", async () => {
    const r = await turn([answer], { config: { historyWarningMessages: 1 } });
    assert.match(r.text, /\[上下文较大\]/);
    assert.ok(r.session.messages.some((m) => m.role === "assistant" && /\[上下文较大\]/.test(m.content ?? "")), "notice must land in history");
    // A second turn in the same session must not repeat it.
    const before = r.session.messages.length;
    rounds = [answer];
    await runTurn({ conn: { async sessionUpdate() {} }, session: r.session, provider: new OpenAIProvider(cfg),
      tools: new ToolRegistry([]), signal: new AbortController().signal,
      config: { maxIterations: 5, historyWarningMessages: 1, permissionMode: "confirm", systemPrompt: null } });
    const notices = r.session.messages.slice(before).filter((m) => /\[上下文较大\]/.test(m.content ?? ""));
    assert.equal(notices.length, 0, "warning is once per session");
  });
  await check("transient pre-first-delta failures retry, mid-stream failures do not", async () => {
    const r = await turn(["fail500", answer]);
    assert.equal(r.stopReason, "end_turn");
    assert.equal(requests.length, 2);
    const log = await readFile(join(dir, "logs", "global.log"), "utf8");
    assert.match(log, /LLM retry/);

    // A failure after the first delta must not re-run the request.
    const mid = await turn(["midfail"]);
    assert.equal(mid.stopReason, "refusal");
    assert.equal(requests.length, 1);
    assert.match(mid.text, /调用模型失败/);

    // Cap: default 2 retries → 3 attempts total for 3 consecutive failures.
    const capped = await turn(["fail500", "fail500", "fail500", answer]);
    assert.equal(capped.stopReason, "refusal");
    assert.equal(requests.length, 3);
    assert.equal(capped.session.messages.filter((m) => m.role === "assistant").length, 0, "no duplicated assistant turns");
  });
  await check("402/401/400/429 map to Chinese, actionable messages and are not blindly retried", async () => {
    const insufficientBalance = await turn(["insufficient-balance"]);
    assert.equal(insufficientBalance.stopReason, "refusal");
    assert.match(insufficientBalance.text, /余额不足/);
    assert.equal(requests.length, 1, "402 must not be retried");

    const badKey = await turn(["bad-key"]);
    assert.equal(badKey.stopReason, "refusal");
    assert.match(badKey.text, /API Key 无效/);
    assert.equal(requests.length, 1, "401 must not be retried");

    // 429 is still retried (transient), but if it never recovers the final
    // message must still be the friendly one, not the raw SDK text.
    const rateLimited = { ...cfg, streamRetries: 0 };
    rounds = ["rate-limit"];
    requests = [];
    const session = new Session(randomUUID(), dir, [], caps, "confirm", "test");
    session.messages = [{ role: "user", content: "test" }];
    session.abort = new AbortController();
    const updates = [];
    const stopReason = await runTurn({
      conn: { async sessionUpdate(p) { updates.push(p.update); } }, session,
      provider: new (await import("../dist/llm/openai.js")).OpenAIProvider(rateLimited),
      tools: new ToolRegistry([]), signal: session.abort.signal,
      config: { maxIterations: 5, historyWarningMessages: 3, permissionMode: "confirm", systemPrompt: null },
    });
    assert.equal(stopReason, "refusal");
    const text = updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("");
    assert.match(text, /并发\/速率上限/);
  });
  await check("retry respects Retry-After, caps the delay, and yields to cancellation", async () => {
    const providerCfg = { ...cfg, streamRetries: 1, streamRetryBaseDelayMs: 10 };
    rounds = ["rate-limit", answer];
    const started = Date.now();
    let done = false;
    for await (const ev of new OpenAIProvider(providerCfg).streamChat({ messages: [], tools: [], signal: new AbortController().signal })) {
      if (ev.type === "done") done = true;
    }
    assert.ok(done);
    assert.ok(Date.now() - started >= 800, `Retry-After must be honored (${Date.now() - started}ms)`);

    // Cancellation during the backoff wait must reject immediately.
    rounds = ["fail500", answer];
    const controller = new AbortController();
    const before = requests.length;
    const rejectReason = new Error("user-cancel");
    const pending = (async () => {
      await assert.rejects(async () => {
        for await (const _ of new OpenAIProvider({ ...cfg, streamRetryBaseDelayMs: 5000 }).streamChat({ messages: [], tools: [], signal: controller.signal })) { /* consume */ }
      }, (e) => e === rejectReason);
    })();
    for (let i = 0; i < 200 && requests.length === before; i++) await new Promise((r) => setTimeout(r, 10));
    setTimeout(() => controller.abort(rejectReason), 100);
    await pending;
    assert.equal(requests.length, before + 1, "cancelled retry must not issue a second request");
  });
  await check("tool deadline fires without killing the whole turn", async () => {
    const hanging = {
      ...guardedWrite,
      run: async () => new Promise(() => {}),
    };
    const r = await turn([finish("tool_calls", [callDelta("write_file", '{"path":"x","content":"y"}')]), answer], {
      toolList: [hanging], config: { toolTimeoutMs: 100 },
    });
    assert.equal(r.stopReason, "end_turn", "turn must continue after a tool deadline");
    assert.match(r.session.messages.find((m) => m.role === "tool").content, /工具执行超时（100ms）/);
    assert.match(r.session.messages.find((m) => m.role === "tool").content, /重试/);
    const failed = r.updates.filter((u) => u.sessionUpdate === "tool_call_update" && u.status === "failed");
    assert.equal(failed.length, 1);
  });
  await check("bash kills the whole process group on timeout", async () => {
    const pwned = join(dir, "PWNED");
    await rm(pwned, { force: true });
    const session = new Session(randomUUID(), dir, [], caps, "confirm", "test");
    const command = `node -e "setTimeout(()=>require('fs').writeFileSync('${pwned}','x'),4000)"`;
    const result = await bashTool.run({ command, timeout: 300 }, {
      conn: {}, session, signal: new AbortController().signal,
    });
    assert.match(result.output, /命令执行超时（300ms）/);
    assert.equal(result.raw.signal, "SIGKILL");
    assert.equal(result.raw.timedOut, true);
    await new Promise((r) => setTimeout(r, 1500));
    await assert.rejects(() => readFile(pwned, "utf8"), "grandchild must not survive the kill");
    await rm(pwned, { force: true });
  });
  await check("user cancellation outranks the tool deadline", async () => {
    let sawAbort = false;
    const aborting = {
      ...guardedWrite,
      run: async (_a, { signal }) => new Promise((resolve) => {
        signal.addEventListener("abort", () => { sawAbort = true; resolve({ output: "aborted" }); });
      }),
    };
    const r = await turn([finish("tool_calls", [callDelta("write_file", '{"path":"x","content":"y"}')])], {
      toolList: [aborting], config: { toolTimeoutMs: 2000 },
      setup: (session) => setTimeout(() => session.abort.abort(), 30),
    });
    assert.equal(r.stopReason, "cancelled");
    assert.ok(sawAbort, "the tool must observe the abort");
    assert.match(r.session.messages.find((m) => m.role === "tool").content, /turn 被取消/);
  });
  await check("per-model maxTokens overrides the global output budget", async () => {
    const { OpenAIProvider } = await import("../dist/llm/openai.js");
    assert.equal(new OpenAIProvider(cfg).maxTokens, 100, "global value by default");
    const perModel = new OpenAIProvider({
      ...cfg,
      models: [{ modelId: "test", name: "test", maxTokens: 32768 }],
    });
    assert.equal(perModel.maxTokens, 32768);
    // The override is what actually goes on the wire.
    rounds = [answer];
    requests = [];
    for await (const _ of perModel.streamChat({ messages: [], tools: [], signal: new AbortController().signal })) { /* consume */ }
    assert.equal(requests[0].max_tokens, 32768);
  });
  await check("unset maxTokens omits max_tokens entirely, letting the backend default apply", async () => {
    const { OpenAIProvider } = await import("../dist/llm/openai.js");
    const unset = { ...cfg };
    delete unset.maxTokens;
    const provider = new OpenAIProvider(unset);
    assert.equal(provider.maxTokens, undefined);
    rounds = [answer];
    requests = [];
    for await (const _ of provider.streamChat({ messages: [], tools: [], signal: new AbortController().signal })) { /* consume */ }
    assert.ok(!("max_tokens" in requests[0]), "max_tokens must not be sent when unconfigured");

    // Truncation notice must describe "server default", not a bare "unknown".
    rounds = [finish("length", [])];
    const session = new Session(randomUUID(), dir, [], caps, "confirm", "test");
    session.messages = [{ role: "user", content: "test" }];
    session.abort = new AbortController();
    const updates = [];
    const conn = { async sessionUpdate(p) { updates.push(p.update); } };
    const stopReason = await runTurn({ conn, session, provider: new OpenAIProvider(unset),
      tools: new ToolRegistry([]), signal: session.abort.signal,
      config: { maxIterations: 5, historyWarningMessages: 3, permissionMode: "confirm", systemPrompt: null } });
    assert.equal(stopReason, "max_tokens");
    const text = updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("");
    assert.match(text, /使用服务端默认额度/);
    assert.ok(!text.includes("maxTokens=unknown"));
  });
  await check("first-chunk/idle/total watchdogs and user abort close the HTTP stream", async () => {
    for (const kind of ["first-chunk", "idle", "total", "cancel"]) {
      // "idle" round: connection opens, nothing is ever sent — exercises the
      // pre-first-chunk wait. "one-chunk-then-silent": one chunk arrives (so
      // firstChunkTimer is satisfied), then silence — only the idle-between-
      // chunks watchdog can catch this one.
      rounds = [kind === "first-chunk" ? "idle" : kind === "idle" ? "one-chunk-then-silent" : "reasoning-forever"];
      const controller = new AbortController();
      const provider = new OpenAIProvider({
        ...cfg,
        // A first-chunk timeout is retryable (see isRetryable); with only one
        // queued round this test wants the single-attempt failure, not a
        // retry consuming an empty `rounds` queue into an accidental success.
        ...(kind === "first-chunk" ? { streamRetries: 0 } : {}),
        models: [{
          modelId: "test", name: "test",
          firstChunkTimeoutMs: kind === "first-chunk" ? 100 : 5000,
          streamIdleTimeoutMs: kind === "idle" ? 100 : 1000,
          streamTotalTimeoutMs: kind === "total" ? 150 : 2000,
        }],
      });
      const before = closed;
      const timer = kind === "cancel" ? setTimeout(() => controller.abort(new Error("user-cancel")), 100) : null;
      try {
        await assert.rejects(async () => {
          for await (const _ of provider.streamChat({ messages: [], tools: [], signal: controller.signal })) { /* consume */ }
        }, (e) => kind === "cancel" ? e.message === "user-cancel" : e instanceof StreamTimeoutError && e.kind === kind);
        // Allow the server to observe transport closure.
        for (let i = 0; i < 50 && closed === before; i++) await new Promise((r) => setTimeout(r, 10));
        assert.ok(closed > before, "server must observe stream abort");
      } finally { clearTimeout(timer); }
    }
  });
  await check("SSE keep-alive comments during the pre-first-chunk wait don't trip the idle watchdog", async () => {
    // A busy DeepSeek endpoint sends `: keep-alive` while queueing; the SDK
    // drops these before they'd become a `chunk`. A short idle timeout must
    // NOT fire during that window — only firstChunkTimeoutMs governs it.
    rounds = ["keep-alive-then-answer"];
    const provider = new OpenAIProvider({ ...cfg, streamIdleTimeoutMs: 50, models: [{ modelId: "test", name: "test", firstChunkTimeoutMs: 5000 }] });
    let sawText = false;
    for await (const ev of provider.streamChat({ messages: [], tools: [], signal: new AbortController().signal })) {
      if (ev.type === "text-delta") sawText = true;
    }
    assert.ok(sawText, "keep-alive comments must not starve the request before the first real chunk arrives");
  });
  await check("a first-chunk timeout is retried (nothing streamed yet → safe, unlike idle/total)", async () => {
    rounds = ["idle", answer]; // first attempt never responds; second attempt succeeds
    requests = [];
    const provider = new OpenAIProvider({
      ...cfg, streamRetries: 1, streamRetryBaseDelayMs: 5,
      models: [{ modelId: "test", name: "test", firstChunkTimeoutMs: 50 }],
    });
    let finishReason = null;
    for await (const ev of provider.streamChat({ messages: [], tools: [], signal: new AbortController().signal })) {
      if (ev.type === "done") finishReason = ev.finishReason;
    }
    assert.equal(requests.length, 2, "must retry after a first-chunk timeout");
    assert.equal(finishReason, "stop");
  });
  await check("dispose aborts an active tool before closing MCP connections", async () => {
    const tool = { ...guardedWrite, run: async (_args, { session, signal }) => {
      const aborted = new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      session.mcpConnections = [{ close: async () => assert.ok(signal.aborted) }];
      setTimeout(() => void session.dispose(), 10);
      await aborted;
      signal.throwIfAborted();
    } };
    const r = await turn([finish("tool_calls", [callDelta(write.name, '{"path":"x","content":"y"}')])], { toolList: [tool] });
    assert.equal(r.stopReason, "cancelled");
  });
  await check("cancel during unanswered permission request prevents execution", async () => {
    const r = await turn([finish("tool_calls", [callDelta(write.name, '{"path":"x","content":"y"}')])], {
      toolList: [guardedWrite], permission: (session) => {
        setTimeout(() => session.abort.abort(), 10);
        return new Promise(() => {});
      },
    });
    assert.equal(r.stopReason, "cancelled");
    assert.equal(executed, 1);
  });
  await check("ACP stop reasons, session/cancel, stdin EOF and shutdown abort real requests", async () => {
    await mkdir(join(dir, ".zhente"), { recursive: true });
    await writeFile(join(dir, "AGENTS.md"), "Test project");
    await writeFile(join(dir, ".zhente", "memory.md"), "Test memory");
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ provider: cfg, agent: { permissionMode: "auto" }, skills: { enabled: false } }));
    for (const mode of ["cancel", "stdin", "shutdown"]) {
      const child = spawn(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname, "--config", path], {
        // 隔离 HOME：分层加载（D16）会把 ~/.config/zhente/config.json 当 base。
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, HOME: join(dir, "home"), ZHENTE_LOG_DIR: join(dir, "child-logs") },
      });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d; });
      const exit = new Promise((resolve) => child.once("exit", resolve));
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      const conn = new ClientSideConnection(() => ({
        async sessionUpdate() {},
        async requestPermission() { return { outcome: { outcome: "cancelled" } }; },
      }), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
      try {
        await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
        const s = await conn.newSession({ cwd: dir, mcpServers: [] });
        const prompt = () => conn.prompt({ sessionId: s.sessionId, prompt: [{ type: "text", text: "test" }] });
        if (mode === "cancel") {
          for (const [reason, expected] of [["length", "max_tokens"], ["content_filter", "refusal"]]) {
            rounds = [finish(reason)];
            assert.equal((await prompt()).stopReason, expected);
          }
        }
        rounds = ["idle"];
        const beforeRequests = requests.length;
        const pending = prompt().catch(() => null);
        for (let i = 0; i < 100 && requests.length === beforeRequests; i++) await new Promise((r) => setTimeout(r, 10));
        assert.ok(requests.length > beforeRequests, "request must be active");
        const beforeClosed = closed;
        if (mode === "cancel") {
          await conn.cancel({ sessionId: s.sessionId });
          assert.equal((await pending).stopReason, "cancelled");
          child.stdin.end();
        } else if (mode === "stdin") child.stdin.end();
        else child.kill("SIGTERM");
        assert.equal(await exit, 0, stderr);
        await pending;
        assert.ok(closed > beforeClosed, "shutdown must close active HTTP request");
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    }
  });
  await check("user-level instructions (~/.config/zhente/AGENTS.md) load before project memory", async () => {
    const project = join(dir, "memory-project");
    const home = join(dir, "memory-home");
    await mkdir(join(project, ".zhente"), { recursive: true });
    await mkdir(join(home, ".config", "zhente"), { recursive: true });
    await writeFile(join(project, "AGENTS.md"), "PROJECT-AGENTS");
    await writeFile(join(project, ".zhente", "memory.md"), "PROJECT-MEMORY");
    await writeFile(join(home, ".config", "zhente", "AGENTS.md"), "USER-MEMORY");
    const path = join(project, "config.json");
    await writeFile(path, JSON.stringify({ provider: cfg, agent: { permissionMode: "auto" }, mcp: { enabled: false }, skills: { enabled: false } }));
    rounds = [answer];
    requests = [];
    const child = spawn(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname, "--config", path], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: home, ZHENTE_LOG_DIR: join(dir, "memory-logs"), ZHENTE_SESSION_DIR: join(dir, "memory-sessions") },
    });
    const exit = new Promise((r) => child.once("exit", r));
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const conn = new ClientSideConnection(() => ({
      async sessionUpdate() {},
      async requestPermission() { return { outcome: { outcome: "selected", optionId: "allow_once" } }; },
    }), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
    try {
      await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const s = await conn.newSession({ cwd: project, mcpServers: [] });
      await conn.prompt({ sessionId: s.sessionId, prompt: [{ type: "text", text: "hi" }] });
      const system = String(requests.at(-1)?.messages?.find((m) => m.role === "system")?.content ?? "");
      assert.ok(system.includes("USER-MEMORY"), "全局指令进 system prompt");
      assert.ok(system.includes("PROJECT-AGENTS") && system.includes("PROJECT-MEMORY"), "项目记忆照旧加载");
      assert.ok(system.indexOf("USER-MEMORY") < system.indexOf("PROJECT-AGENTS"), "顺序 = 全局 → 项目");
    } finally {
      clearTimeout(timeout);
      child.kill("SIGKILL");
      await exit;
    }
  });

  await check("prompt size is estimated (and calibrated with usage) before each request", async () => {
    const { estimateText, estimateTokens, calibrateEstimate, shouldCompact } = await import("../dist/harness/context.js");
    assert.equal(estimateTokens([], []), 0);
    assert.equal(estimateText("a".repeat(40)), 10, "ascii ≈ 4 chars/token");
    assert.equal(estimateText("中".repeat(15)), 10, "non-ascii ≈ 1.5 chars/token");
    assert.equal(estimateText(null), 0);
    const oneMessage = estimateTokens([{ role: "user", content: "a".repeat(40) }]);
    assert.ok(oneMessage > 10, "per-message overhead is included");
    // A long single message and a tool schema both count.
    const withTools = estimateTokens([{ role: "user", content: "hi" }], [{ name: "bash", description: "x".repeat(400), parameters: { type: "object" } }]);
    assert.ok(withTools > estimateTokens([{ role: "user", content: "hi" }], []));
    // Calibration only applies with both data points, and stays within 0.5×–2×.
    assert.equal(calibrateEstimate(100, null, 500), 100);
    assert.equal(calibrateEstimate(100, 50, 500), 200, "ratio clamps at 2×");
    assert.equal(calibrateEstimate(100, 1000, 1), 50, "ratio clamps at 0.5×");
    assert.equal(calibrateEstimate(100, 100, 300), 200, "ratio clamps at 2× (300/100 → 2)");
    assert.equal(calibrateEstimate(100, 100, 150), 150, "in-range ratio applies as-is");
    assert.equal(shouldCompact(80_000, 128_000, 0.8), false);
    assert.equal(shouldCompact(102_400, 128_000, 0.8), true);

    // Logged before the request, with the calibrated value once usage arrives.
    await turn([{ ...answer, usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }]);
    const log = await readFile(join(dir, "logs", "global.log"), "utf8");
    assert.match(log, /estimatedPromptTokens=\d+ rawEstimate=\d+ lastPromptTokens=(none|\d+)/);
  });
  await check("logs contain counts/usage but no reasoning or raw parameters", async () => {
    await turn([{ ...answer, usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }]);
    const log = await readFile(join(dir, "logs", "global.log"), "utf8");
    assert.match(log, /reasoningChars=17/);
    assert.match(log, /"total_tokens":7/);
    assert.match(log, /历史上下文较大/);
    assert.ok(!log.includes("private reasoning"));
    assert.ok(!log.includes('{"path":'));
  });
  await check("cache hit/miss usage is extracted and logged as cacheHitRatio", async () => {
    const withCache = {
      ...answer,
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 2 },
    };
    await turn([withCache]);
    let log = await readFile(join(dir, "logs", "global.log"), "utf8");
    assert.match(log, /"prompt_cache_hit_tokens":8,"prompt_cache_miss_tokens":2/);
    assert.match(log, /cacheHitRatio=0\.80/);

    // No cache fields reported → falls back to "n/a" rather than a stale/misleading number.
    await turn([{ ...answer, usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }]);
    log = await readFile(join(dir, "logs", "global.log"), "utf8");
    assert.match(log, /cacheHitRatio=n\/a/);

    // `prompt_tokens_details.cached_tokens` (non-DeepSeek shape) is accepted too.
    await turn([{ ...answer, usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 4 } } }]);
    const { OpenAIProvider: Provider } = await import("../dist/llm/openai.js");
    const provider = new Provider(cfg);
    rounds = [{ ...answer, usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 4 } } }];
    for await (const _ of provider.streamChat({ messages: [], tools: [], signal: new AbortController().signal })) { /* consume */ }
    assert.equal(provider.lastUsage.prompt_cache_hit_tokens, 4);
  });
  console.error(`RELIABILITY SMOKE OK (${checks} groups)`);
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
}
