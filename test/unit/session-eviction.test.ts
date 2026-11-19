import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { ClientChannel } from "../../src/acp/client-channel.js";
import { SangxiaAgent } from "../../src/agent.js";
import type { Config } from "../../src/config.js";
import { trackedSessionCount } from "../../src/persistence.js";
import type { Session } from "../../src/session.js";

// SA-7: live sessions (history, persistence bookkeeping, MCP child processes)
// used to stay in memory until process exit. Idle sessions are now evicted
// after `agent.sessionIdleTimeoutMs` and rebuilt from the JSONL log on demand.

const IDLE_MS = 60_000;
const later = () => Date.now() + IDLE_MS + 1;

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "sangxia-evict-"));
  process.env.SANGXIA_SESSION_DIR = join(dir, "sessions");
});
after(() => rmSync(dir, { recursive: true, force: true }));

function makeConfig(overrides: { idleMs?: number; mcp?: boolean } = {}): Config {
  return {
    provider: {
      type: "mock",
      model: "model-a",
      models: [{ modelId: "model-a", name: "A" }, { modelId: "model-b", name: "B" }],
    },
    agent: {
      maxIterations: 5,
      historyWarningMessages: 400,
      toolTimeoutMs: 300_000,
      sessionIdleTimeoutMs: overrides.idleMs ?? IDLE_MS,
      permissionMode: "auto",
      systemPrompt: null,
    },
    mcp: { enabled: overrides.mcp ?? false, connectTimeoutMs: 15_000 },
    skills: { enabled: false, dirs: [] },
    hooks: { enabled: false },
  } as unknown as Config;
}

const conn = {
  sessionUpdate: async () => {},
  requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
} as unknown as ClientChannel;

async function newAgent(config = makeConfig()) {
  const agent = new SangxiaAgent(conn, config);
  await agent.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  return agent;
}

function fakeMcp(): { conn: Session["mcpConnections"][number]; closed: () => number } {
  let closed = 0;
  return {
    conn: { close: async () => { closed++; } } as unknown as Session["mcpConnections"][number],
    closed: () => closed,
  };
}

describe("idle session eviction (SA-7)", () => {
  it("releases an idle session's history, MCP connections, bookkeeping and provider", async () => {
    const agent = await newAgent();
    const { sessionId } = await agent.newSession({ cwd: dir, mcpServers: [] });
    const session = agent.getSession(sessionId)!;
    const mcp = fakeMcp();
    session.mcpConnections.push(mcp.conn);
    (agent as unknown as { providerFor(id: string): unknown }).providerFor("model-a");
    const trackedBefore = trackedSessionCount();

    assert.deepEqual(await agent.evictIdleSessions(), [], "a freshly active session is kept");
    assert.deepEqual(await agent.evictIdleSessions(later()), [sessionId]);

    assert.equal(agent.getSession(sessionId), undefined, "no longer held in the live map");
    assert.equal(mcp.closed(), 1, "MCP connection closed on eviction");
    assert.equal(trackedSessionCount(), trackedBefore - 1, "persistence bookkeeping dropped");
    assert.deepEqual(agent.cachedProviderModels(), [], "provider no session uses is released");
    assert.deepEqual(agent.evictedSessionIds(), [sessionId]);
    await agent.shutdown();
  });

  it("transparently rebuilds an evicted session on the next request, keeping its state", async () => {
    const agent = await newAgent();
    const { sessionId } = await agent.newSession({ cwd: dir, mcpServers: [] });
    await agent.setSessionModel({ sessionId, modelId: "model-b" });
    const before = agent.getSession(sessionId)!;
    before.messages.push({ role: "user", content: "hello" }, { role: "assistant", content: "喵" });
    before.permissions.set("bash:prefix:npm test", "allow");
    before.initializationChecked = true;
    const { persistSession } = await import("../../src/persistence.js");
    await persistSession(before);
    const history = structuredClone(before.messages);

    await agent.evictIdleSessions(later());
    assert.equal(agent.getSession(sessionId), undefined);

    // Any session request rebuilds it (set_mode is avoided: it clears permission memory by design).
    const { configOptions } = await agent.setSessionConfigOption({ sessionId, configId: "model", value: "model-b" });
    assert.equal(configOptions.find((o) => o.id === "model")?.currentValue, "model-b");
    const after = agent.getSession(sessionId)!;
    assert.ok(after, "session is live again");
    assert.notEqual(after, before);
    assert.deepEqual(after.messages, history, "history replayed losslessly from the log");
    assert.equal(after.modelId, "model-b");
    assert.equal(after.permissionMode, "auto");
    assert.equal(after.permissions.get("bash:prefix:npm test"), "allow", "'always allow' memory survives eviction");
    assert.equal(after.initializationChecked, true, "project-init question is not asked again");
    assert.deepEqual(agent.evictedSessionIds(), []);
    await agent.shutdown();
  });

  it("shares one rebuild between concurrent requests", async () => {
    const agent = await newAgent();
    const { sessionId } = await agent.newSession({ cwd: dir, mcpServers: [] });
    await agent.evictIdleSessions(later());
    await Promise.all([
      agent.setSessionMode({ sessionId, modeId: "confirm" }),
      agent.setSessionModel({ sessionId, modelId: "model-b" }),
    ]);
    const session = agent.getSession(sessionId)!;
    assert.equal(session.permissionMode, "confirm");
    assert.equal(session.modelId, "model-b", "both requests landed on the same restored Session");
    await agent.shutdown();
  });

  it("runs a full prompt turn on a rebuilt session", async () => {
    const agent = await newAgent();
    const { sessionId } = await agent.newSession({ cwd: dir, mcpServers: [] });
    await agent.evictIdleSessions(later());
    const { stopReason } = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "写个文件" }] });
    assert.equal(stopReason, "end_turn");
    const messages = agent.getSession(sessionId)!.messages;
    assert.equal(messages[0]!.role, "system", "restored history still starts with the system prompt");
    assert.ok(messages.some((m) => m.role === "user" && m.content === "写个文件"));
    await agent.shutdown();
  });

  it("never evicts a session whose turn is running, and restarts the idle clock when it ends", async () => {
    const agent = await newAgent();
    const { sessionId } = await agent.newSession({ cwd: dir, mcpServers: [] });
    const session = agent.getSession(sessionId)!;
    session.promptInFlight = true;
    assert.deepEqual(await agent.evictIdleSessions(later()), []);
    session.promptInFlight = false;
    session.lastActivityAt = Date.now();
    assert.deepEqual(await agent.evictIdleSessions(Date.now() + IDLE_MS / 2), [], "not idle long enough");
    assert.equal(agent.getSession(sessionId), session);
    await agent.shutdown();
  });

  it("keeps sessions forever when sessionIdleTimeoutMs is 0", async () => {
    const agent = await newAgent(makeConfig({ idleMs: 0 }));
    const { sessionId } = await agent.newSession({ cwd: dir, mcpServers: [] });
    assert.deepEqual(await agent.evictIdleSessions(Date.now() + 10 * 365 * 86_400_000), []);
    assert.ok(agent.getSession(sessionId));
    await agent.shutdown();
  });

  it("lets session/load supersede an evicted stub", async () => {
    const agent = await newAgent();
    const { sessionId } = await agent.newSession({ cwd: dir, mcpServers: [] });
    await agent.evictIdleSessions(later());
    await agent.loadSession({ sessionId, cwd: dir, mcpServers: [] });
    assert.ok(agent.getSession(sessionId));
    assert.deepEqual(agent.evictedSessionIds(), []);
    await agent.shutdown();
  });

  it("disconnects a real MCP server on eviction and reconnects it lazily", async () => {
    const agent = await newAgent(makeConfig({ mcp: true }));
    const server: McpServer = { name: "mock", command: process.execPath, args: [resolve("scripts/mock-mcp-server.mjs")], env: [] };
    const { sessionId } = await agent.newSession({ cwd: dir, mcpServers: [server] });
    const first = agent.getSession(sessionId)!;
    assert.equal(first.mcpConnections.length, 1);
    const mcpToolNames = first.tools.list().map((t) => t.name).filter((n) => n.startsWith("mcp__"));
    assert.ok(mcpToolNames.length > 0);

    await agent.evictIdleSessions(later());
    assert.equal(first.mcpConnections.length, 0, "child process connection closed while idle");

    await agent.setSessionMode({ sessionId, modeId: "auto" });
    const second = agent.getSession(sessionId)!;
    assert.equal(second.mcpConnections.length, 1, "reconnected on the next request");
    assert.deepEqual(second.tools.list().map((t) => t.name).filter((n) => n.startsWith("mcp__")), mcpToolNames);
    await agent.shutdown();
  });

  it("preserves updated system prompt after in-place mutation and eviction", async () => {
    const agent = await newAgent();
    const { sessionId } = await agent.newSession({ cwd: dir, mcpServers: [] });
    const session = agent.getSession(sessionId)!;
    const system = session.messages.find((m) => m.role === "system")!;
    system.content = "mutated system prompt with project memory";
    const { persistHistoryReset } = await import("../../src/persistence.js");
    await persistHistoryReset(session);

    await agent.evictIdleSessions(later());
    assert.equal(agent.getSession(sessionId), undefined);

    await agent.setSessionMode({ sessionId, modeId: "confirm" });
    const restored = agent.getSession(sessionId)!;
    assert.equal(
      restored.messages.find((m) => m.role === "system")?.content,
      "mutated system prompt with project memory",
      "rebuilt session must reflect the in-place system prompt change",
    );
    await agent.shutdown();
  });

  it("cancels prompt received during slow rebuild when session/cancel arrives", async () => {
    const agent = await newAgent();
    const { sessionId } = await agent.newSession({ cwd: dir, mcpServers: [] });
    await agent.evictIdleSessions(later());
    assert.equal(agent.getSession(sessionId), undefined);

    const origPrepare = (agent as unknown as { prepareSession(s: Session): Promise<void> }).prepareSession.bind(agent);
    (agent as unknown as { prepareSession(s: Session): Promise<void> }).prepareSession = async (s: Session) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return origPrepare(s);
    };

    const promptPromise = agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "hello while rebuilding" }],
    });

    // Send cancel while rebuild is still in flight
    await new Promise((resolve) => setTimeout(resolve, 10));
    await agent.cancel({ sessionId });

    const result = await promptPromise;
    assert.equal(result.stopReason, "cancelled");

    (agent as unknown as { prepareSession(s: Session): Promise<void> }).prepareSession = origPrepare;
    const second = await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "next prompt after cancel" }],
    });
    assert.equal(second.stopReason, "end_turn");
    await agent.shutdown();
  });

  it("still rejects an id that was never a session", async () => {
    const agent = await newAgent();
    await assert.rejects(() => agent.setSessionMode({ sessionId: "nope", modeId: "auto" }), /Invalid params/);
    await agent.shutdown();
  });
});
