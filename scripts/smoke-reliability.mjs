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

const dir = await mkdtemp(join(tmpdir(), "zhente-reliability-"));
process.env.ZHENTE_SESSION_DIR = join(dir, "sessions");
logger.configure({ stderr: false, dir: join(dir, "logs") });
let rounds = [], requests = [], closed = 0;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const part of req) body += part;
  requests.push(JSON.parse(body));
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.flushHeaders();
  const round = rounds.shift();
  const send = (delta, finish_reason) => res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`);
  let interval;
  res.on("close", () => { closed++; clearInterval(interval); });
  if (round === "idle") return;
  if (round === "reasoning-forever") {
    interval = setInterval(() => send({ reasoning_content: "private reasoning" }), 10);
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
  const saved = JSON.parse(await readFile(join(dir, "sessions", `${session.id}.json`), "utf8"));
  assert.deepEqual(saved.messages, JSON.parse(JSON.stringify(session.messages)));
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
    assert.match(requests[1].messages.at(-1).content, /上次响应未产生正文/);
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
