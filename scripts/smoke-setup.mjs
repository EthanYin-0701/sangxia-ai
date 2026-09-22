import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeOpenAI } from "./lib/fake-openai.mjs";
import { entry, startAgent, registryInitialize } from "./lib/acp-process.mjs";

const work = mkdtempSync(join(tmpdir(), "sangxia-setup-"));
const key = "smoke-secret-do-not-print";
const env = { PATH: process.env.PATH, HOME: work, TERM: "dumb", SX_TEST_KEY: key };
const path = join(work, ".config/sangxia/config.json");
const requests = [];
const servers = [];
let agent;
async function fake(options = {}) {
  const server = createFakeOpenAI({ ...options, onRequest(req, body) {
    requests.push({ url: req.url, body });
    assert.equal(req.headers.authorization, `Bearer ${key}`);
  } });
  servers.push(server);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}/v1`;
}
async function setup(args, expected = 0) {
  const child = spawn(process.execPath, [entry, "setup", ...args], { cwd: work, env });
  let stdout = "", stderr = "";
  child.stdout.on("data", c => { stdout += c; });
  child.stderr.on("data", c => { stderr += c; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, expected, stderr);
    assert.equal(stdout, "", "setup must not write to stdout");
    assert.ok(!stderr.includes(key), "setup must not print the API key");
    return stderr;
  } finally { clearTimeout(timer); }
}
const args = url => ["--non-interactive", "--provider", "openai", "--base-url", url, "--model", "m", "--api-key-env", "SX_TEST_KEY"];
try {
  mkdirSync(join(work, ".config/sangxia"), { recursive: true });
  const hooks = { enabled: true, events: { session_start: [{ command: "echo '{\"decision\":\"allow\"}'" }] } };
  writeFileSync(path, JSON.stringify({ hooks, agent: { maxIterations: 77 }, mcp: { enabled: false } }));
  await setup(args(await fake()));
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.provider.apiKey, "${SX_TEST_KEY}");
  assert.deepEqual(saved.hooks, hooks);
  assert.equal(saved.agent.maxIterations, 77);
  assert.equal(saved.mcp.enabled, false);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  agent = startAgent({ cwd: work, env });
  assert.ok((await agent.request("initialize", registryInitialize)).result.authMethods.length);
  assert.ok((await agent.request("session/new", { cwd: work, mcpServers: [] })).result.sessionId);
  assert.deepEqual((await agent.request("authenticate", { methodId: "terminal-setup" })).result, {});
  await agent.close();
  assert.ok(!agent.stderr.includes(key));
  for (const modelsStatus of [404, 405]) {
    requests.length = 0;
    await setup(args(await fake({ modelsStatus })));
    assert.deepEqual(requests.map(r => r.url), ["/v1/models", "/v1/chat/completions"]);
    assert.equal(requests[1].body.stream, false);
    assert.equal(requests[1].body.max_tokens, 1);
  }
  const before = readFileSync(path, "utf8");
  requests.length = 0;
  await setup(args(await fake({ modelsStatus: 401 })), 1);
  assert.equal(requests.length, 1, "401 must not fall back");
  assert.equal(readFileSync(path, "utf8"), before);
  await setup(args(await fake({ modelsStatus: 404, chatStatus: 401 })), 1);
  assert.equal(readFileSync(path, "utf8"), before);
  for (const bad of [
    ["--provider", "unknown"], ["--api-key-env", "MISSING_KEY"], ["--api-key-env", "BAD-NAME"],
    ["--base-url", "invalid"], ["--model", ""], ["--api-key"], ["--api-key", key, "--api-key-env", "SX_TEST_KEY"],
  ]) {
    await setup(["--non-interactive", ...bad], 1);
    assert.equal(readFileSync(path, "utf8"), before);
  }
  requests.length = 0;
  await setup([...args(await fake()), "--skip-verify"]);
  assert.equal(requests.length, 0);
  // Non-TTY implies non-interactive without the flag; literals and mock also work.
  await setup(["--api-key", key, "--skip-verify"]);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).provider.apiKey, key);
  await setup(["--provider", "mock"]);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).provider.type, "mock");
  writeFileSync(path, "broken JSON");
  await setup(["--provider", "mock"], 1);
  assert.equal(readFileSync(path, "utf8"), "broken JSON");
  console.error("SETUP SMOKE OK: merge, auth, permissions, verification fallback, failure preservation, headless CLI");
} finally {
  agent?.child.kill("SIGKILL");
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  rmSync(work, { recursive: true, force: true });
}
