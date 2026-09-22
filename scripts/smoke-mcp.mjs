// Smoke test for MCP client + skill layer (offline, no network / API key).
//
// Part 1 (integration): spawn the agent as an ACP subprocess, newSession with a
//   stdio MCP server (scripts/mock-mcp-server.mjs) plus a temp skill, and assert
//   from the agent's stderr that it connected the server and discovered the skill.
// Part 2 (execution): connect to the mock MCP server directly via the built
//   connectMcpServer(), call mcp__mock__echo, then exercise discoverSkills + use_skill.
//
// Run: npm run build && node scripts/smoke-mcp.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@zed-industries/agent-client-protocol";

import { connectMcpServer } from "../dist/mcp/client.js";
import { discoverSkills, skillCatalogPrompt, useSkillTool } from "../dist/skills/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const mockServer = join(root, "scripts/mock-mcp-server.mjs");
const workdir = mkdtempSync(join(tmpdir(), "sangxia-mcp-"));
// 隔离的 HOME：分层加载（D16）会把 `~/.config/sangxia/config.json` 当 base，
// 冒烟不能读到开发机真实的全局配置（hooks / provider 都可能与本场景冲突）。
const home = join(workdir, "home");

// A demo skill living in the session cwd.
mkdirSync(join(workdir, "skills", "hello"), { recursive: true });
writeFileSync(
  join(workdir, "skills", "hello", "SKILL.md"),
  "---\nname: hello\ndescription: 打招呼的示例技能。\n---\n# Hello\n收到问候时用中文回复「你好！」。\n",
);

const cfgPath = join(workdir, "sangxia.config.json");
writeFileSync(cfgPath, JSON.stringify({ provider: { type: "mock", model: "mock" } }));

const mcpServers = [{ name: "mock", command: "node", args: [mockServer], env: [] }];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- Part 1: ACP integration ----------------
const child = spawn("node", [join(root, "dist/index.js"), "--config", cfgPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, HOME: home },
});
let stderr = "";
child.stderr.on("data", (d) => {
  stderr += d.toString();
  process.stderr.write(d);
});

const failTimer = setTimeout(() => {
  console.error("SMOKE-MCP TIMEOUT");
  child.kill("SIGKILL");
  process.exit(1);
}, 30_000);

const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
const client = {
  async sessionUpdate() {},
  async requestPermission() {
    return { outcome: { outcome: "selected", optionId: "allow_once" } };
  },
};
const conn = new ClientSideConnection(() => client, stream);

try {
  const init = await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
  });
  assert.ok(init.agentCapabilities?.mcpCapabilities, "应声明 mcpCapabilities");
  console.error("✓ initialize (已声明 mcpCapabilities)");

  const session = await conn.newSession({ cwd: workdir, mcpServers });
  assert.ok(session.sessionId, "应返回 sessionId");
  await delay(400); // let the agent's stderr flush
  assert.match(stderr, /MCP 'mock' 已连接/, "应连接 mock MCP server");
  assert.match(stderr, /mcpTools=1/, "应注册 1 个 MCP 工具");
  assert.match(stderr, /skills=1/, "应发现 1 个技能");
  console.error("✓ newSession 连接 MCP + 发现技能 (从 agent 日志确认)");

  clearTimeout(failTimer);
  child.kill("SIGTERM");
} catch (e) {
  clearTimeout(failTimer);
  child.kill("SIGKILL");
  console.error("\nSMOKE-MCP FAILED ❌ (part 1)");
  console.error(e);
  process.exit(1);
}

// ---------------- Part 2: direct execution ----------------
try {
  const mcp = await connectMcpServer(mcpServers[0], 15_000);
  const echo = mcp.tools.find((t) => t.name === "mcp__mock__echo");
  assert.ok(echo, "应有 mcp__mock__echo 工具");
  assert.equal(echo.needsPermission, true, "MCP 工具应默认门控");
  const res = await echo.run({ text: "hi" }, { signal: new AbortController().signal });
  assert.match(res.output, /echo: hi/, "callTool 应回显");
  console.error(`✓ MCP 工具执行: ${echo.name} → ${JSON.stringify(res.output)}`);
  await mcp.close();

  const skills = await discoverSkills(workdir, []);
  assert.equal(skills.length, 1, "应发现 1 个技能");
  assert.match(skillCatalogPrompt(skills), /hello: 打招呼的示例技能。/, "目录应含技能描述");
  const body = await useSkillTool.run({ name: "hello" }, { session: { skills }, signal: new AbortController().signal });
  assert.match(body.output, /你好/, "use_skill 应返回 SKILL.md 正文");
  console.error("✓ 技能发现 + use_skill 正文加载");

  console.error("\nSMOKE-MCP OK ✅");
  process.exit(0);
} catch (e) {
  console.error("\nSMOKE-MCP FAILED ❌ (part 2)");
  console.error(e);
  process.exit(1);
}
