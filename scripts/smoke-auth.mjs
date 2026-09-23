import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entry, startAgent, registryInitialize } from "./lib/acp-process.mjs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const version = createRequire(import.meta.url)("../package.json").version;
const work = mkdtempSync(join(tmpdir(), "sangxia-auth-"));
let count = 0;
async function scenario(name, { raw, env = {}, args = [], reason, model } = {}) {
  const dir = join(work, name), home = join(dir, "home"), cwd = join(dir, "cwd");
  mkdirSync(home, { recursive: true }); mkdirSync(cwd);
  if (raw !== undefined) writeFileSync(join(cwd, "sangxia.config.json"), typeof raw === "string" ? raw : JSON.stringify(raw));
  // Exactly the registry sandbox environment for the unconfigured scenario.
  const agent = startAgent({ cwd, env: { PATH: process.env.PATH, HOME: home, TERM: "dumb", ...env }, args });
  try {
    const init = (await agent.request("initialize", registryInitialize)).result;
    assert.equal(init.protocolVersion, 1);
    const deepseek = init.authMethods.find(m => m.id === "deepseek-setup");
    assert.ok(deepseek, "must advertise the DeepSeek auth method");
    assert.equal(deepseek.type, "terminal");
    assert.deepEqual(deepseek.args, ["setup", "--preset", "deepseek"]);
    assert.equal(deepseek._meta["terminal-auth"], true);
    assert.match(deepseek.name, /DeepSeek/);
    assert.match(deepseek.description, /api\.deepseek\.com/);
    const generic = init.authMethods.find(m => m.id === "terminal-setup");
    assert.ok(generic && generic.type === "terminal" && generic.args.includes("setup"));
    assert.deepEqual(init.agentInfo, { name: "sangxia", title: "Sangxia.ai", version });
    const session = await agent.request("session/new", { cwd, mcpServers: [] });
    if (reason) {
      for (const response of [
        session,
        await agent.request("session/load", { sessionId: "missing", cwd, mcpServers: [] }),
        await agent.request("session/prompt", { sessionId: "missing", prompt: [{ type: "text", text: "hi" }] }),
        await agent.request("authenticate", { methodId: "terminal-setup" }),
      ]) {
        assert.equal(response.error.code, -32000, JSON.stringify(response));
        // The message is what clients render most reliably; guidance must be in it.
        assert.match(response.error.message, /setup --preset deepseek/);
        assert.match(response.error.data.reason, reason);
        assert.match(response.error.data.hint, /setup/);
      }
    } else {
      assert.ok(session.result?.sessionId, JSON.stringify(session));
      if (model) assert.equal(session.result.models.currentModelId, model);
      assert.deepEqual((await agent.request("authenticate", { methodId: "terminal-setup" })).result, {});
    }
    assert.equal((await agent.request("authenticate", { methodId: "unknown" })).error.code, -32602);
    assert.equal(agent.child.exitCode, null, "agent must remain alive after requests");
    await agent.close();
    assert.ok(!agent.stderr.includes("never-log-this-key"));
    count++;
  } finally { agent.child.kill("SIGKILL"); }
}
try {
  await scenario("empty", { reason: /未找到配置/ });
  await scenario("invalid-json", { raw: "{ broken", reason: /读取\/解析/ });
  await scenario("invalid-schema", { raw: { provider: { type: "bad" } }, reason: /配置无效/ });
  await scenario("missing-env", { raw: { provider: { apiKey: "${SX_MISSING}" } }, reason: /SX_MISSING/ });
  await scenario("empty-env", { raw: { provider: { apiKey: "${SX_EMPTY}" } }, env: { SX_EMPTY: "" }, reason: /SX_EMPTY/ });
  await scenario("no-key", { raw: { provider: { type: "openai" } }, reason: /provider.apiKey 为空/ });
  await scenario("blank-key", { raw: { provider: { apiKey: "  " } }, reason: /provider.apiKey 为空/ });
  await scenario("missing-file", { args: ["--config", "missing.json"], env: { SANGXIA_API_KEY: "never-log-this-key" }, reason: /读取\/解析/ });
  await scenario("missing-config-arg", { args: ["--config"], reason: /需要文件路径/ });
  await scenario("mock", { raw: { provider: { type: "mock" } } });
  await scenario("bootstrap", { env: { SANGXIA_API_KEY: "never-log-this-key" }, model: "gpt-4o" });
  await scenario("bootstrap-overrides", { env: { SANGXIA_API_KEY: "never-log-this-key", SANGXIA_BASE_URL: "http://127.0.0.1:1/v1", SANGXIA_MODEL: "env-model" }, model: "env-model" });
  await scenario("bootstrap-invalid", { env: { SANGXIA_API_KEY: "never-log-this-key", SANGXIA_BASE_URL: "invalid" }, reason: /baseURL/ });
  await scenario("file-wins", { raw: { provider: { type: "mock", model: "file-model" } }, env: { SANGXIA_API_KEY: "never-log-this-key", SANGXIA_MODEL: "env-model" }, model: "file-model" });
  await scenario("broken-file-no-fallback", { raw: "broken", env: { SANGXIA_API_KEY: "never-log-this-key" }, reason: /读取\/解析/ });
  for (const flag of ["--version", "-v", "--help", "-h"]) {
    const result = spawnSync(process.execPath, [entry, flag], { cwd: work, env: { PATH: process.env.PATH, HOME: work, TERM: "dumb" }, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0); assert.equal(result.stderr, "");
    assert.ok(result.stdout.includes(version));
  }
  console.error(`AUTH SMOKE OK: ${count} sandbox scenarios, CLI help/version, clean stdout and shutdown`);
} finally { rmSync(work, { recursive: true, force: true }); }
