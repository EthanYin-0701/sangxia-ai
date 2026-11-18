import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { InitializeRequest } from "@agentclientprotocol/sdk";
import type { ClientChannel } from "../../src/acp/client-channel.js";
import { SangxiaAgent } from "../../src/agent.js";
import type { Config } from "../../src/config.js";

// SA-58: terminal auth methods (ACP protocol/v1/authentication) may be
// advertised only to clients that enabled terminal-auth support, via the
// standard `clientCapabilities.auth.terminal` (SDK 2.7.0) or the legacy
// `_meta["terminal-auth"]` convention.

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "sangxia-auth-methods-"));
  process.env.SANGXIA_SESSION_DIR = join(dir, "sessions");
});
after(() => rmSync(dir, { recursive: true, force: true }));

const config = {
  provider: { type: "mock", model: "model-a", models: [{ modelId: "model-a", name: "A" }] },
  agent: { maxIterations: 5, historyWarningMessages: 400, toolTimeoutMs: 300_000, permissionMode: "auto", systemPrompt: null },
  mcp: { enabled: false, connectTimeoutMs: 1000 },
  skills: { enabled: false, dirs: [] },
  hooks: { enabled: false },
} as unknown as Config;

const conn = { sessionUpdate: async () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) } as unknown as ClientChannel;

async function authMethodIds(clientCapabilities: InitializeRequest["clientCapabilities"]): Promise<string[]> {
  const agent = new SangxiaAgent(conn, config);
  const res = await agent.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities });
  return (res.authMethods ?? []).map((m) => m.id);
}

describe("terminal auth advertisement (SA-58)", () => {
  it("withholds terminal methods from a client that signals no terminal-auth support", async () => {
    assert.deepEqual(await authMethodIds({}), []);
    // The `terminal` capability means terminal* client methods, not terminal auth.
    assert.deepEqual(await authMethodIds({ terminal: true }), []);
  });

  it("advertises terminal methods when the standard auth.terminal capability is set", async () => {
    assert.deepEqual(await authMethodIds({ auth: { terminal: true } }), ["deepseek-setup", "terminal-setup"]);
  });

  it("advertises terminal methods for a legacy client using the _meta convention", async () => {
    assert.deepEqual(
      await authMethodIds({ _meta: { "terminal-auth": true } } as InitializeRequest["clientCapabilities"]),
      ["deepseek-setup", "terminal-setup"],
    );
  });

  it("treats auth.terminal: false as no support", async () => {
    assert.deepEqual(await authMethodIds({ auth: { terminal: false } }), []);
  });
});
