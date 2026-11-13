import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { PROTOCOL_VERSION, type AgentSideConnection } from "@agentclientprotocol/sdk";
import { SangxiaAgent } from "../../src/agent.js";
import type { Config } from "../../src/config.js";
import type { Session } from "../../src/session.js";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "sangxia-agent-"));
  process.env.SANGXIA_SESSION_DIR = join(dir, "sessions");
});
after(() => rmSync(dir, { recursive: true, force: true }));

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
  mcp: { enabled: false, connectTimeoutMs: 1000 },
  skills: { enabled: false, dirs: [] },
  hooks: { enabled: false },
} as unknown as Config;

const conn = {
  sessionUpdate: async () => {},
  requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
} as unknown as AgentSideConnection;

async function newAgent() {
  const agent = new SangxiaAgent(conn, config);
  await agent.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  return agent;
}

/** A stand-in for a live MCP connection (a stdio child process in real life). */
function fakeMcp(): { conn: Session["mcpConnections"][number]; closed: () => number } {
  let closed = 0;
  return {
    conn: { close: async () => { closed++; } } as unknown as Session["mcpConnections"][number],
    closed: () => closed,
  };
}

// `providerFor` is what `prompt` uses; calling it directly keeps the test free of LLM turns.
const providerFor = (agent: SangxiaAgent, modelId: string) =>
  (agent as unknown as { providerFor(id: string): unknown }).providerFor(modelId);

describe("loadSession replacing a live session (SA-12)", () => {
  it("closes the replaced session's MCP connections and keeps only the new one live", async () => {
    const agent = await newAgent();
    const { sessionId } = await agent.newSession({ cwd: dir, mcpServers: [] });
    const old = agent.getSession(sessionId)!;
    const mcp = fakeMcp();
    old.mcpConnections.push(mcp.conn);

    await agent.loadSession({ sessionId, cwd: dir, mcpServers: [] });

    assert.equal(mcp.closed(), 1, "old MCP connection closed, not leaked");
    assert.equal(old.mcpConnections.length, 0);
    const current = agent.getSession(sessionId)!;
    assert.notEqual(current, old);

    // Loading twice in a row (editor reconnect) keeps releasing the previous instance.
    const again = fakeMcp();
    current.mcpConnections.push(again.conn);
    await agent.loadSession({ sessionId, cwd: dir, mcpServers: [] });
    assert.equal(again.closed(), 1);
    await agent.shutdown();
  });

  it("aborts an in-flight turn of the replaced session and waits for it to settle", async () => {
    const agent = await newAgent();
    const { sessionId } = await agent.newSession({ cwd: dir, mcpServers: [] });
    const old = agent.getSession(sessionId)!;
    // Simulate what prompt() sets up for a running turn.
    const abort = new AbortController();
    old.abort = abort;
    old.promptInFlight = true;
    let settled = false;
    old.turnSettled = new Promise<void>((resolve) => {
      abort.signal.addEventListener("abort", () => setTimeout(() => {
        settled = true;
        old.promptInFlight = false;
        resolve();
      }, 20));
    });

    await agent.loadSession({ sessionId, cwd: dir, mcpServers: [] });

    assert.equal(abort.signal.aborted, true, "old turn was cancelled");
    assert.equal(settled, true, "load waited for the old turn to finish writing its history");
    await agent.shutdown();
  });

  it("still rejects an unknown session id", async () => {
    const agent = await newAgent();
    await assert.rejects(() => agent.loadSession({ sessionId: "does-not-exist", cwd: dir, mcpServers: [] }), (e: { data?: unknown }) => /找不到已保存会话/.test(JSON.stringify(e.data)));
    await agent.shutdown();
  });
});

describe("provider cache (SA-13)", () => {
  it("drops a provider once no session uses its model", async () => {
    const agent = await newAgent();
    const { sessionId } = await agent.newSession({ cwd: dir, mcpServers: [] });
    providerFor(agent, "model-a");
    await agent.setSessionModel({ sessionId, modelId: "model-b" });
    providerFor(agent, "model-b");
    assert.deepEqual(agent.cachedProviderModels(), ["model-b"], "model-a is no longer used by any session");
    await agent.setSessionModel({ sessionId, modelId: "model-a" });
    assert.deepEqual(agent.cachedProviderModels(), []);
    await agent.shutdown();
  });

  it("keeps a provider another session still uses", async () => {
    const agent = await newAgent();
    const s1 = await agent.newSession({ cwd: dir, mcpServers: [] });
    await agent.newSession({ cwd: dir, mcpServers: [] }); // stays on model-a
    providerFor(agent, "model-a");
    await agent.setSessionModel({ sessionId: s1.sessionId, modelId: "model-b" });
    assert.deepEqual(agent.cachedProviderModels(), ["model-a"]);
    await agent.shutdown();
  });

  it("prunes after a loadSession replacement, keeping models still in use", async () => {
    const agent = await newAgent();
    const { sessionId } = await agent.newSession({ cwd: dir, mcpServers: [] });
    providerFor(agent, "model-a");
    await agent.setSessionModel({ sessionId, modelId: "model-b" });
    providerFor(agent, "model-b");
    await agent.loadSession({ sessionId, cwd: dir, mcpServers: [] }); // restores model-b from the log
    assert.deepEqual(agent.cachedProviderModels(), ["model-b"]);
    await agent.shutdown();
  });

  it("rejects model ids outside the configured list, so the cache is bounded by it", async () => {
    const agent = await newAgent();
    const { sessionId } = await agent.newSession({ cwd: dir, mcpServers: [] });
    await assert.rejects(() => agent.setSessionModel({ sessionId, modelId: `random-${Date.now()}` }), (e: { data?: unknown }) => /未知模型/.test(JSON.stringify(e.data)));
    await agent.shutdown();
  });
});
