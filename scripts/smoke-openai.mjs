// Verifies the REAL OpenAIProvider path (SSE streaming + tool-call accumulation
// + message conversion) against a fake local OpenAI-compatible server. No real
// API key or network. This is what proves the headline "configure any
// OpenAI-compatible endpoint" feature actually works.
//
// Run: npm run build && node scripts/smoke-openai.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
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

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// --- Fake OpenAI-compatible /chat/completions server (streaming) ---------------
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const payload = JSON.parse(body || "{}");
    const isFollowUp = (payload.messages ?? []).some((m) => m.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream" });

    if (!isFollowUp) {
      // First call: emit some text, then a tool_call whose JSON arguments are
      // split across two chunks (exercises the provider's accumulation logic).
      res.write(sse({ choices: [{ index: 0, delta: { role: "assistant", content: "好，" } }] }));
      res.write(sse({ choices: [{ index: 0, delta: { content: "我来创建文件。" } }] }));
      res.write(
        sse({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", type: "function", function: { name: "write_file", arguments: '{"path":"from-openai.txt",' } },
                ],
              },
            },
          ],
        }),
      );
      res.write(
        sse({
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"via openai path\\n"}' } }] } },
          ],
        }),
      );
      res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
    } else {
      // Follow-up (after the tool result): just answer and stop.
      res.write(sse({ choices: [{ index: 0, delta: { role: "assistant", content: "文件已创建完成。" } }] }));
      res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// --- Spawn the agent pointed at the fake server -------------------------------
const workdir = mkdtempSync(join(tmpdir(), "zhente-openai-"));
// 隔离的 HOME：分层加载（D16）会把 `~/.config/zhente/config.json` 当 base，
// 冒烟不能读到开发机真实的全局配置（hooks / provider 都可能与本场景冲突）。
const home = join(workdir, "home");
const cfgPath = join(workdir, "zhente.config.json");
writeFileSync(
  cfgPath,
  JSON.stringify({
    provider: { type: "openai", baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "test-key", model: "test-model", maxTokens: 256 },
    agent: { permissionMode: "auto" },
  }),
);

const child = spawn("node", [join(root, "dist/index.js"), "--config", cfgPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, HOME: home },
});

const failTimer = setTimeout(() => {
  console.error("OPENAI SMOKE TIMEOUT");
  child.kill("SIGKILL");
  server.close();
  process.exit(1);
}, 20_000);

const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
const updates = [];
const client = {
  async sessionUpdate(p) {
    updates.push(p.update);
  },
  async requestPermission() {
    return { outcome: { outcome: "selected", optionId: "allow_once" } };
  },
  async readTextFile(p) {
    return { content: readFileSync(p.path, "utf8") };
  },
  async writeTextFile(p) {
    writeFileSync(p.path, p.content);
    return {};
  },
};
const conn = new ClientSideConnection(() => client, stream);

try {
  const init = await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
  });
  assert.equal(init.protocolVersion, PROTOCOL_VERSION);
  console.error("✓ initialize");

  const session = await conn.newSession({ cwd: workdir, mcpServers: [] });
  console.error("✓ newSession");

  const res = await conn.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "创建 from-openai.txt" }],
  });
  assert.equal(res.stopReason, "end_turn", "stopReason 应为 end_turn");
  console.error(`✓ prompt (stopReason=${res.stopReason})`);

  // The split-across-chunks tool_call must have been reassembled and executed.
  const toolCalls = updates.filter((u) => u.sessionUpdate === "tool_call");
  assert.ok(toolCalls.length >= 1, "应有 tool_call");
  const text = updates
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => u.content.text)
    .join("");
  assert.ok(text.includes("创建文件"), "应流式收到助手文本");

  const created = readFileSync(join(workdir, "from-openai.txt"), "utf8");
  assert.equal(created, "via openai path\n", "工具参数(跨分片累积)应被正确解析并写入");
  console.error(`✓ 跨分片 tool_call 累积正确，文件内容 = ${JSON.stringify(created)}`);

  clearTimeout(failTimer);
  child.kill("SIGTERM");
  server.close();
  console.error("\nOPENAI SMOKE OK ✅");
  process.exit(0);
} catch (e) {
  clearTimeout(failTimer);
  child.kill("SIGKILL");
  server.close();
  console.error("\nOPENAI SMOKE FAILED ❌");
  console.error(e);
  process.exit(1);
}
