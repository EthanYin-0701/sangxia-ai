// Verifies the skills layer end-to-end through the real ACP + harness path:
//   1. `skills.dirs` discovery (frontmatter name/description, incl. YAML folded
//      block scalars à la Claude Code skills — `description: >-`)
//   2. catalog injection into the system prompt
//   3. `use_skill` loading the SKILL.md body back into the conversation
//   4. `use_skill` on an unknown name failing cleanly (error, no crash)
//
// Run: npm run build && node scripts/smoke-skill.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const workdir = mkdtempSync(join(tmpdir(), "zhente-skill-"));

// --- Fixture skills (project skills dir discovered via config `skills.dirs`) ---
const skillDir = join(workdir, ".claude", "skills", "demo");
mkdirSync(skillDir, { recursive: true });
writeFileSync(
  join(skillDir, "SKILL.md"),
  [
    "---",
    "name: demo-skill",
    "description: >-",
    "  Demo skill whose description is a YAML folded block scalar.",
    "  It must show up in the catalog as ONE line, not as the literal '>-'.",
    "---",
    "",
    "# Demo Skill",
    "",
    "BODY-MARKER: follow these steps in order.",
    "",
  ].join("\n"),
);

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// --- Fake OpenAI-compatible server: forces a use_skill tool call --------------
let catalogSeen = null;
let toolResultSeen = null;
let step = 0;

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const payload = JSON.parse(body || "{}");
    const messages = payload.messages ?? [];
    const toolMsgs = messages.filter((m) => m.role === "tool");
    catalogSeen ??= messages.find((m) => m.role === "system")?.content ?? "";
    res.writeHead(200, { "content-type": "text/event-stream" });

    const emitToolCall = (name) => {
      step += 1;
      res.write(
        sse({
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${step}`,
                    type: "function",
                    function: { name: "use_skill", arguments: JSON.stringify({ name }) },
                  },
                ],
              },
            },
          ],
        }),
      );
      res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
    };

    for (const m of toolMsgs) {
      toolResultSeen = toolResultSeen === null ? m.content : `${toolResultSeen}\n${m.content}`;
    }

    if (toolMsgs.length === 0) {
      // Step 1: unknown name → must come back as a readable error, not a crash.
      emitToolCall("nope-such-skill");
    } else if (toolMsgs.length === 1) {
      // Step 2: the real skill → body is expected in the tool result.
      emitToolCall("demo-skill");
    } else {
      res.write(sse({ choices: [{ index: 0, delta: { role: "assistant", content: "已加载技能并按其步骤执行。" } }] }));
      res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// --- Spawn the agent pointed at the fake server -------------------------------
const cfgPath = join(workdir, "zhente.config.json");
writeFileSync(
  cfgPath,
  JSON.stringify({
    provider: {
      type: "openai",
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: "test-key",
      model: "test-model",
      maxTokens: 256,
    },
    agent: { permissionMode: "auto" },
    skills: { enabled: true, dirs: [".claude/skills"] },
  }),
);

const child = spawn("node", [join(root, "dist/index.js"), "--config", cfgPath], {
  stdio: ["pipe", "pipe", "inherit"],
});

const failTimer = setTimeout(() => {
  console.error("SKILL SMOKE TIMEOUT");
  child.kill("SIGKILL");
  server.close();
  process.exit(1);
}, 25_000);

const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
const updates = [];
const client = {
  async sessionUpdate(p) {
    updates.push(p.update);
  },
  async requestPermission() {
    return { outcome: { outcome: "selected", optionId: "allow_once" } };
  },
};

try {
  const conn = new ClientSideConnection(() => client, stream);
  await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
  });
  console.error("✓ initialize");

  const session = await conn.newSession({ cwd: workdir, mcpServers: [] });
  console.error("✓ newSession");

  const res = await conn.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "用 demo-skill 干活" }],
  });
  assert.equal(res.stopReason, "end_turn", "stopReason 应为 end_turn");

  // 1) catalog: folded description folded into one line, name from frontmatter.
  assert.ok(catalogSeen, "应捕获到 system prompt");
  assert.ok(
    catalogSeen.includes(
      "- demo-skill: Demo skill whose description is a YAML folded block scalar. It must show up in the catalog as ONE line, not as the literal '>-'.",
    ),
    `system prompt 应含折叠后的技能目录项，实际含: ${JSON.stringify(catalogSeen.slice(-400))}`,
  );
  assert.ok(!catalogSeen.includes("- demo-skill: >-"), "目录不应显示字面量 '>-'");
  console.error("✓ 技能目录注入 system prompt（折叠描述已解析）");

  // 2) tool results: unknown name → error; known name → body (progressive disclosure).
  assert.ok(toolResultSeen !== null, "use_skill 应有 tool result");
  assert.match(toolResultSeen, /未找到技能 "nope-such-skill"/, "未知技能应返回可读错误");
  assert.match(toolResultSeen, /BODY-MARKER: follow these steps in order\./, "use_skill 应加载技能正文");
  console.error("✓ use_skill: 未知名称报错、已知名称加载正文");

  // 3) no permission prompt for use_skill (read-only local file).
  const titles = updates.filter((u) => u.sessionUpdate === "tool_call").map((u) => u.title);
  assert.ok(
    titles.some((t) => t?.includes("加载技能 demo-skill")),
    `应看到 use_skill 的 tool_call 标题，实际: ${JSON.stringify(titles)}`,
  );
  const text = updates
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => u.content.text)
    .join("");
  assert.ok(text.includes("已加载技能并按其步骤执行。"), "助手最终文本应流式到达");
  console.error(`✓ tool_call 标题 = ${JSON.stringify(titles)}`);

  clearTimeout(failTimer);
  child.kill("SIGTERM");
  server.close();
  console.error("\nSKILL SMOKE OK ✅");
  process.exit(0);
} catch (e) {
  clearTimeout(failTimer);
  child.kill("SIGKILL");
  server.close();
  console.error("\nSKILL SMOKE FAILED ❌");
  console.error(e);
  process.exit(1);
}
