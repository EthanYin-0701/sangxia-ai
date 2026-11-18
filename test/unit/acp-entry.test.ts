import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { type McpServer, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type { ClientChannel } from "../../src/acp/client-channel.js";
import { SangxiaAgent } from "../../src/agent.js";
import type { Config } from "../../src/config.js";
import { logger } from "../../src/logger.js";
import { connectMcpServer } from "../../src/mcp/client.js";
import { modelStateFromConfigOptions } from "../../src/tui/session-models.js";

// SA-65 Step A: ACP entry-point hardening (wire-level routing and logging: agent-app.test.ts).

let dir: string;
let logFile: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "sangxia-acp-entry-"));
  process.env.SANGXIA_SESSION_DIR = join(dir, "sessions");
  logFile = join(dir, "agent.log");
  logger.configure({ file: logFile, stderr: false });
});
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => writeFileSync(logFile, ""));

const config = {
  provider: {
    type: "mock",
    model: "model-a",
    models: [
      { modelId: "model-a", name: "A" },
      { modelId: "model-b", name: "B" },
    ],
  },
  agent: { maxIterations: 5, historyWarningMessages: 400, toolTimeoutMs: 300_000, permissionMode: "auto", systemPrompt: null },
  mcp: { enabled: true, connectTimeoutMs: 1000 },
  skills: { enabled: false, dirs: [] },
  hooks: { enabled: false },
} as unknown as Config;

const conn = {
  sessionUpdate: async () => {},
  requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
} as unknown as ClientChannel;

async function newSession(mcpServers: McpServer[] = []) {
  const agent = new SangxiaAgent(conn, config);
  await agent.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  const { sessionId } = await agent.newSession({ cwd: dir, mcpServers });
  return { agent, sessionId };
}

/** Assert a promise rejects with a JSON-RPC `RequestError` of the given code. */
async function rejectsWithCode(p: Promise<unknown>, code: number) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof RequestError, `expected RequestError, got ${String(e)}`);
    assert.equal(e.code, code);
    return true;
  });
}

const unknownTransport = { type: "acp", name: "ide", serverId: "s1" } as unknown as McpServer;

describe("extMethod set_model (SA-65 #4)", () => {
  // The SDK hands extMethod the raw, unvalidated params; these used to surface
  // as a TypeError → -32603 Internal error instead of -32602.
  for (const [label, params] of [
    ["null params", null],
    ["array params", []],
    ["missing modelId", { sessionId: "x" }],
    ["non-string modelId", { sessionId: "x", modelId: 42 }],
  ] as const) {
    it(`answers -32602 for ${label}`, async () => {
      const { agent } = await newSession();
      await rejectsWithCode(agent.extMethod("_sangxia.set_model", params), -32602);
    });
  }

  it("still switches the model through `_sangxia.set_model`", async () => {
    const { agent, sessionId } = await newSession();
    assert.deepEqual(await agent.extMethod("_sangxia.set_model", { sessionId, modelId: "model-b" }), {});
    assert.equal(agent.getSession(sessionId)!.modelId, "model-b");
  });

  it("reports unknown methods with their wire name, not a doubled `_` prefix", async () => {
    const { agent } = await newSession();
    await assert.rejects(agent.extMethod("_custom.thing", {}), (e: unknown) => {
      assert.ok(e instanceof RequestError);
      assert.equal(e.code, -32601);
      assert.deepEqual(e.data, { method: "_custom.thing" });
      return true;
    });
  });
});

describe("setSessionConfigOption value guard (SA-65 #6)", () => {
  it("rejects a non-string value with -32602 and leaves the model unchanged", async () => {
    const { agent, sessionId } = await newSession();
    const params = { sessionId, configId: "model", value: true } as unknown as Parameters<SangxiaAgent["setSessionConfigOption"]>[0];
    await rejectsWithCode(agent.setSessionConfigOption(params), -32602);
    assert.equal(agent.getSession(sessionId)!.modelId, "model-a");
  });
});

describe("MCP transport types (SA-65 #3)", () => {
  it("rejects an unknown `type` explicitly instead of treating it as HTTP", async () => {
    await assert.rejects(connectMcpServer(unknownTransport, 1000), /不支持的 MCP 传输类型: "acp"/);
  });

  it("skips that one server without failing session/new", async () => {
    const { agent, sessionId } = await newSession([unknownTransport]);
    assert.equal(agent.getSession(sessionId)!.mcpConnections.length, 0);
    assert.match(readFileSync(logFile, "utf8"), /MCP 'ide' 连接失败: 不支持的 MCP 传输类型/);
  });
});

describe("TUI model state from configOptions (SA-65 #1)", () => {
  it("reads the model selector that session/new returns", async () => {
    const agent = new SangxiaAgent(conn, config);
    await agent.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const res = await agent.newSession({ cwd: dir, mcpServers: [] });
    assert.deepEqual(modelStateFromConfigOptions(res.configOptions), {
      currentModelId: "model-a",
      availableModels: [{ modelId: "model-a", name: "A" }, { modelId: "model-b", name: "B" }],
    });
  });

  it("flattens grouped options and returns null without a model selector", () => {
    assert.deepEqual(modelStateFromConfigOptions([{
      id: "model", name: "Model", type: "select", currentValue: "y",
      options: [{ group: "g", name: "G", options: [{ value: "x", name: "X" }, { value: "y", name: "Y" }] }],
    }]), { currentModelId: "y", availableModels: [{ modelId: "x", name: "X" }, { modelId: "y", name: "Y" }] });
    assert.equal(modelStateFromConfigOptions(undefined), null);
    assert.equal(modelStateFromConfigOptions([{ id: "mode", name: "Mode", type: "select", currentValue: "auto", options: [] }]), null);
  });
});
