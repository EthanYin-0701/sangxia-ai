// End-to-end smoke test: act as an ACP client, spawn the agent as a subprocess,
// drive initialize -> newSession -> prompt against the offline `mock` provider,
// and assert the full handshake + tool + permission flow. No network / API key.
//
// Run: npm run build && node scripts/smoke.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@zed-industries/agent-client-protocol";

const root = fileURLToPath(new URL("..", import.meta.url));
const workdir = mkdtempSync(join(tmpdir(), "zhente-smoke-"));
const cfgPath = join(workdir, "zhente.config.json");
writeFileSync(
  cfgPath,
  JSON.stringify({
    provider: {
      type: "mock",
      model: "mock-fast",
      models: [
        { modelId: "mock-fast", name: "Mock Fast" },
        { modelId: "mock-pro", name: "Mock Pro" },
      ],
    },
    agent: { permissionMode: "confirm" },
  }),
);

const child = spawn("node", [join(root, "dist/index.js"), "--config", cfgPath], {
  stdio: ["pipe", "pipe", "inherit"],
});

const failTimer = setTimeout(() => {
  console.error("SMOKE TIMEOUT");
  child.kill("SIGKILL");
  process.exit(1);
}, 20_000);

const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));

const updates = [];
let permissionAsked = false;

const client = {
  async sessionUpdate(params) {
    updates.push(params.update);
  },
  async requestPermission(params) {
    permissionAsked = true;
    console.error(`  [client] 权限请求: ${params.toolCall.title}`);
    return { outcome: { outcome: "selected", optionId: "allow_once" } };
  },
  async readTextFile(params) {
    return { content: readFileSync(params.path, "utf8") };
  },
  async writeTextFile(params) {
    writeFileSync(params.path, params.content);
    return {};
  },
};

const conn = new ClientSideConnection(() => client, stream);

try {
  const init = await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
  });
  assert.equal(init.protocolVersion, PROTOCOL_VERSION, "protocolVersion 应为 1");
  console.error(`✓ initialize (protocolVersion=${init.protocolVersion})`);

  const session = await conn.newSession({ cwd: workdir, mcpServers: [] });
  assert.ok(session.sessionId, "应返回 sessionId");
  assert.equal(session.modes?.currentModeId, "confirm", "默认应为 confirm 模式");
  assert.deepEqual(
    session.modes?.availableModes.map((mode) => mode.id),
    ["confirm", "auto"],
    "应暴露 confirm/auto 两种 ACP session mode",
  );
  assert.equal(session.models?.currentModelId, "mock-fast", "应返回默认 ACP session model");
  assert.deepEqual(
    session.models?.availableModels.map((model) => model.modelId),
    ["mock-fast", "mock-pro"],
    "应暴露配置的 ACP session models",
  );
  await conn.setSessionMode({ sessionId: session.sessionId, modeId: "auto" });
  await conn.setSessionMode({ sessionId: session.sessionId, modeId: "confirm" });
  console.error(`✓ newSession (${session.sessionId})`);

  const res = await conn.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "创建 hello.txt 并确认内容" }],
  });
  assert.equal(res.stopReason, "end_turn", "stopReason 应为 end_turn");
  console.error(`✓ prompt (stopReason=${res.stopReason})`);

  // Assertions on the streamed session updates.
  const toolCalls = updates.filter((u) => u.sessionUpdate === "tool_call");
  const toolNames = toolCalls.map((u) => u.title);
  assert.ok(toolCalls.length >= 2, `应至少有 2 个 tool_call，实际 ${toolCalls.length}`);
  assert.ok(permissionAsked, "write_file 应触发 requestPermission");
  assert.ok(
    updates.some((u) => u.sessionUpdate === "agent_message_chunk"),
    "应有 agent_message_chunk 文本流",
  );
  assert.ok(
    updates.some((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed"),
    "应有 completed 的 tool_call_update",
  );

  const created = readFileSync(join(workdir, "hello.txt"), "utf8");
  assert.equal(created, "hello from zhente\n", "hello.txt 内容应匹配");
  console.error(`✓ 文件已创建: hello.txt = ${JSON.stringify(created)}`);
  console.error(`✓ 工具调用: ${toolNames.join(" · ")}`);

  clearTimeout(failTimer);
  child.kill("SIGTERM");
  console.error("\nSMOKE OK ✅");
  process.exit(0);
} catch (e) {
  clearTimeout(failTimer);
  child.kill("SIGKILL");
  console.error("\nSMOKE FAILED ❌");
  console.error(e);
  process.exit(1);
}
