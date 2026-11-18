import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  type ClientContext,
  PROTOCOL_VERSION,
  RequestError,
  type SessionNotification,
  client,
  methods,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { serveAgent } from "../../src/acp/agent-app.js";
import { SangxiaAgent } from "../../src/agent.js";
import { loadConfig, type Config, type ProviderConfig } from "../../src/config.js";
import { modelEfforts } from "../../src/efforts.js";
import { OpenAIProvider } from "../../src/llm/openai.js";
import { logger } from "../../src/logger.js";

/**
 * Effort selector (`configOptions.effort` → request body `reasoning_effort`).
 *
 * Covered here: config resolution (values/default/opt-out), the ACP surface
 * (only advertised when declared, -32602 for unknown values, re-clamp on model
 * switch, restored by session/load) and the wire body (session value wins over
 * `extraBody.reasoning_effort`).
 */

let dir: string;
let logFile: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "sangxia-effort-"));
  // Isolate from the developer's own ~/.config/sangxia/config.json, which is
  // always layered in as the base config (its `models` would leak into fixtures).
  process.env.HOME = join(dir, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  process.env.SANGXIA_SESSION_DIR = join(dir, "sessions");
  writeFileSync(join(dir, "AGENTS.md"), "# Test project");
  mkdirSync(join(dir, ".sangxia"));
  writeFileSync(join(dir, ".sangxia/memory.md"), "# Memory");
  logFile = join(dir, "agent.log");
  logger.configure({ file: logFile, stderr: false });
});
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => writeFileSync(logFile, ""));

/** Parse a provider block through the real loader (zod + defaults). */
function providerConfig(provider: Record<string, unknown>): ProviderConfig {
  const path = join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ provider: { type: "openai", apiKey: "k", ...provider } }));
  return loadConfig(["--config", path]).provider;
}

describe("effort config resolution", () => {
  it("inherits provider.efforts and defaults to high when allowed", () => {
    const efforts = modelEfforts(providerConfig({ model: "deepseek-flash", efforts: { values: ["none", "low", "high", "max"] } }), "deepseek-flash");
    assert.deepEqual(efforts, { values: ["none", "low", "high", "max"], default: "high" });
  });

  it("falls back to the first value when there is no high", () => {
    const efforts = modelEfforts(providerConfig({ model: "m", efforts: { values: ["low", "max"] } }), "m");
    assert.equal(efforts?.default, "low");
  });

  it("lets a model override or opt out of the provider list", () => {
    const cfg = providerConfig({
      model: "a",
      efforts: { values: ["low", "high"], default: "low" },
      models: [
        { modelId: "a", name: "A" },
        { modelId: "b", name: "B", efforts: { values: ["none", "max"] } },
        { modelId: "c", name: "C", efforts: null },
      ],
    });
    assert.deepEqual(modelEfforts(cfg, "a"), { values: ["low", "high"], default: "low" });
    assert.deepEqual(modelEfforts(cfg, "b"), { values: ["none", "max"], default: "none" });
    assert.equal(modelEfforts(cfg, "c"), null, "null opts the model out");
  });

  it("is absent without an efforts block (nothing is sent to plain backends)", () => {
    assert.equal(modelEfforts(providerConfig({ model: "gpt-4o" }), "gpt-4o"), null);
  });

  it("rejects a default that is not one of the values", () => {
    assert.throws(
      () => providerConfig({ model: "m", efforts: { values: ["low", "high"], default: "max" } }),
      /efforts\.default 必须是 values 之一/,
    );
    assert.throws(
      () => providerConfig({ model: "a", models: [{ modelId: "a", name: "A", efforts: { values: ["low", "low"] } }] }),
      /efforts\.values 不可重复/,
    );
  });

  it("rejects an empty values list (use null to opt a model out)", () => {
    assert.throws(() => providerConfig({ model: "m", efforts: { values: [] } }), /配置无效/);
  });
});

describe("reasoning_effort on the wire", () => {
  let server: Server;
  let baseURL: string;
  const bodies: Record<string, unknown>[] = [];
  before(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  after(() => server.close());

  async function send(cfg: ProviderConfig, reasoningEffort?: string): Promise<Record<string, unknown>> {
    const before = bodies.length;
    const provider = new OpenAIProvider(cfg);
    for await (const _ of provider.streamChat({
      messages: [{ role: "user", content: "u" }],
      tools: [],
      signal: new AbortController().signal,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    })) {
      // drain
    }
    assert.equal(bodies.length, before + 1);
    return bodies.at(-1)!;
  }

  it("sends the selected effort", async () => {
    const body = await send(providerConfig({ model: "deepseek-flash", baseURL }), "max");
    assert.equal(body.reasoning_effort, "max");
  });

  it("prefers the session selection over a static extraBody.reasoning_effort", async () => {
    const cfg = providerConfig({ model: "deepseek-flash", baseURL, efforts: { values: ["low", "high"] }, extraBody: { reasoning_effort: "high" } });
    const body = await send(cfg, "low");
    assert.equal(body.reasoning_effort, "low");
    const withoutSelection = await send(cfg);
    assert.equal(withoutSelection.reasoning_effort, "high", "static extraBody still applies when nothing was picked");
  });
});

describe("effort through ACP (session config option)", () => {
  function makeConfig(providerMode: "effort" | "plain"): Config {
    return {
      provider: {
        type: "mock",
        model: "deepseek-flash",
        models: [
          { modelId: "deepseek-flash", name: "Flash" },
          { modelId: "deepseek-v4-pro", name: "Pro", efforts: { values: ["low", "max"], default: "max" } },
        ],
        ...(providerMode === "effort" ? { efforts: { values: ["none", "low", "high", "max"], default: "high" } } : {}),
      },
      agent: { maxIterations: 5, historyWarningMessages: 400, toolTimeoutMs: 300_000, permissionMode: "auto", systemPrompt: null },
      mcp: { enabled: false, connectTimeoutMs: 1000 },
      skills: { enabled: false, dirs: [] },
      hooks: { enabled: false },
    } as unknown as Config;
  }

  function connect(providerMode: "effort" | "plain") {
    const a = new PassThrough();
    const b = new PassThrough();
    const { agent, connection } = serveAgent(
      ndJsonStream(Writable.toWeb(b), Readable.toWeb(a)),
      (channel) => new SangxiaAgent(channel, makeConfig(providerMode)),
    );
    const updates: SessionNotification[] = [];
    const clientConnection = client()
      .onNotification(methods.client.session.update, ({ params }) => {
        updates.push(params);
      })
      .connect(ndJsonStream(Writable.toWeb(a), Readable.toWeb(b)));
    const ctx: ClientContext = clientConnection.agent;
    return {
      agent,
      updates,
      async initialize() {
        return ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      },
      async newSession() {
        await this.initialize();
        return ctx.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
      },
      async loadSession(sessionId: string) {
        return ctx.request(methods.agent.session.load, { sessionId, cwd: dir, mcpServers: [] });
      },
      setOption: (sessionId: string, configId: string, value: string) =>
        ctx.request(methods.agent.session.setConfigOption, { sessionId, configId, value }),
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

  it("advertises no effort option for models without an efforts block", async () => {
    const wire = connect("plain");
    const session = await wire.newSession();
    assert.deepEqual((session.configOptions ?? []).map((o) => o.id), ["model", "mode"]);
    assert.equal(wire.updates.filter((u) => u.update.sessionUpdate === "config_option_update").length, 0);
    await wire.close();
  });

  it("advertises effort as a thought_level select with the model default", async () => {
    const wire = connect("effort");
    const session = await wire.newSession();
    const effort = (session.configOptions ?? []).find((o) => o.id === "effort");
    assert.ok(effort, "effort option present");
    assert.equal(effort.category, "thought_level");
    assert.equal(effort.type, "select");
    assert.equal(effort.currentValue, "high");
    assert.deepEqual(effort.type === "select" && Array.isArray(effort.options) ? effort.options.map((o) => "value" in o ? o.value : null) : [], ["none", "low", "high", "max"]);
    await wire.close();
  });

  it("switches effort, notifies, persists and restores it on session/load", async () => {
    const wire = connect("effort");
    const session = await wire.newSession();
    const res = await wire.setOption(session.sessionId, "effort", "max");
    assert.equal(res.configOptions.find((o) => o.id === "effort")?.currentValue, "max");
    const update = wire.updates.at(-1)?.update;
    assert.equal(update?.sessionUpdate, "config_option_update");
    assert.equal(
      update?.sessionUpdate === "config_option_update" ? update.configOptions.find((o) => o.id === "effort")?.currentValue : null,
      "max",
    );
    const loaded = await wire.loadSession(session.sessionId);
    assert.equal((loaded.configOptions ?? []).find((o) => o.id === "effort")?.currentValue, "max");
    await wire.close();
  });

  it("persists the effort event in the session log", async () => {
    const wire = connect("effort");
    const session = await wire.newSession();
    await wire.setOption(session.sessionId, "effort", "low");
    const log = readFileSync(join(dir, "sessions", `${session.sessionId}.jsonl`), "utf8");
    assert.match(log, /"t":"effort","effort":"low"/);
    await wire.close();
  });

  it("rejects unknown values and non-selectable models with -32602", async () => {
    const wire = connect("effort");
    const session = await wire.newSession();
    await rejectsWithCode(wire.setOption(session.sessionId, "effort", "ultra"), -32602);
    const plain = connect("plain");
    const plainSession = await plain.newSession();
    await rejectsWithCode(plain.setOption(plainSession.sessionId, "effort", "high"), -32602);
    await wire.close();
    await plain.close();
  });

  it("re-clamps the effort when the model switches", async () => {
    const wire = connect("effort");
    const session = await wire.newSession();
    await wire.setOption(session.sessionId, "effort", "none");
    // deepseek-v4-pro only offers low/max → "none" is not reusable, fall back to its default.
    const switched = await wire.setOption(session.sessionId, "model", "deepseek-v4-pro");
    assert.equal(switched.configOptions.find((o) => o.id === "effort")?.currentValue, "max");
    // …and back: "max" is still offered by flash, so the (re-clamped) value stays.
    const back = await wire.setOption(session.sessionId, "model", "deepseek-flash");
    assert.equal(back.configOptions.find((o) => o.id === "effort")?.currentValue, "max");
    await wire.close();
  });

  it("keeps a still-valid effort across a model switch", async () => {
    const wire = connect("effort");
    const session = await wire.newSession();
    await wire.setOption(session.sessionId, "effort", "low");
    const switched = await wire.setOption(session.sessionId, "model", "deepseek-v4-pro");
    assert.equal(switched.configOptions.find((o) => o.id === "effort")?.currentValue, "low");
    await wire.close();
  });
});
