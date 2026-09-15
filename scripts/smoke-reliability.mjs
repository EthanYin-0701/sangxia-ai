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
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.flushHeaders();
  if (round === "idle") return;
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
  streamIdleTimeoutMs: 1000, streamTotalTimeoutMs: 2000, streamIncludeUsage: true,
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
  const rawSaved = await readFile(join(dir, "sessions", `${session.id}.json`), "utf8").catch(() => null);
  if (rawSaved) {
    const saved = JSON.parse(rawSaved);
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
    assert.ok(!JSON.stringify(requests[1]).includes("private reasoning"));
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
    const repaired = sanitizeHistory([
      { role: "assistant", content: null, tool_calls: [{ id: "call_x", name: "bash", arguments: "{}" }] },
    ]);
    assert.equal(repaired.length, 2);
    assert.match(repaired[1].content, /结果未知/);
    assert.match(repaired[1].content, /核实/);

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
      const saved = JSON.parse(await readFile(join(dir, "sessions", `${sessionId}.json`), "utf8"));
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
  await check("idle/total watchdogs and user abort close the HTTP stream", async () => {
    for (const kind of ["idle", "total", "cancel"]) {
      rounds = [kind === "idle" ? "idle" : "reasoning-forever"];
      const controller = new AbortController();
      const provider = new OpenAIProvider({ ...cfg,
        models: [{ modelId: "test", name: "test", streamIdleTimeoutMs: kind === "idle" ? 100 : 1000, streamTotalTimeoutMs: kind === "total" ? 150 : 2000 }] });
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
        stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ZHENTE_LOG_DIR: join(dir, "child-logs") },
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
  await check("logs contain counts/usage but no reasoning or raw parameters", async () => {
    await turn([{ ...answer, usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }]);
    const log = await readFile(join(dir, "logs", "global.log"), "utf8");
    assert.match(log, /reasoningChars=17/);
    assert.match(log, /"total_tokens":7/);
    assert.match(log, /历史上下文较大/);
    assert.ok(!log.includes("private reasoning"));
    assert.ok(!log.includes('{"path":'));
  });
  console.error(`RELIABILITY SMOKE OK (${checks} groups)`);
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
}
