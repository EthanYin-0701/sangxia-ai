// Verifies the hook (生命周期钩子) layer end-to-end through the real ACP + harness
// path, following plan/hooks_support.md §11:
//   1  hooks.enabled:false ⇒ zero hook processes spawned
//   2  pre_tool_use deny via stdout JSON (tool not run, no permission prompt)
//   3  pre_tool_use deny via exit 2 + stderr reason
//   4  updatedInput takes effect (and drives rawInput/title/tool result)
//   5  invalid updatedInput ⇒ not executed, warn logged
//   6  allow does not skip session/request_permission
//   7  ask overrides remembered "always allow"
//   8  post_tool_use additionalContext (success + failure), deny ignored
//   9  user_prompt_submit deny ⇒ refusal, no LLM call, no user message
//  10  turn_end gets stop_reason (incl. cancelled), init turn is audited
//  11  timeout ⇒ killed, onError decides, turn not stuck
//  12  matcher only fires for matching tools
//  13  tool_calls/tool pairing stays valid after denials (no 400 shape)
//  14  auto + ask ⇒ still prompts (D14)
//  15  needsPermission:false (read_file) + ask ⇒ still prompts (D14)
//  16  relative command resolves against the *config file* dir, not session cwd (D15)
//  17  path-like command that does not exist ⇒ fail fast at startup (D15)
//
// Run: npm run build && node scripts/smoke-hooks.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@zed-industries/agent-client-protocol";

const root = fileURLToPath(new URL("..", import.meta.url));
const workRoot = mkdtempSync(join(tmpdir(), "zhente-hooks-"));
let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
  console.error(`  ✓ ${msg}`);
};

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible server: serves one scripted "round" per LLM request.
// ---------------------------------------------------------------------------
let rounds = [];
let llmRequests = [];
const heldOpen = [];

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const payload = JSON.parse(body || "{}");
    llmRequests.push(payload);
    const round = rounds.shift() ?? { content: "（默认回复）", finish: "stop" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (round.hang) {
      heldOpen.push(res); // never answered: used to exercise cancel/timeout paths
      return;
    }
    const send = (delta, finish) => {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`);
    };
    for (const tc of round.toolCalls ?? []) {
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: tc.id ?? `call_${tc.name}_${llmRequests.length}`,
            type: "function",
            function: {
              name: tc.name,
              arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
            },
          },
        ],
      });
      send({}, "tool_calls");
    }
    if (round.content) send({ role: "assistant", content: round.content });
    send({}, round.finish ?? (round.toolCalls?.length ? "tool_calls" : "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const failTimer = setTimeout(() => {
  console.error("HOOK SMOKE TIMEOUT");
  for (const res of heldOpen) res.destroy();
  server.close();
  for (const child of children) child.kill("SIGKILL");
  process.exit(1);
}, 120_000);
const children = [];

// ---------------------------------------------------------------------------
// Scenario harness
// ---------------------------------------------------------------------------
let permissionCalls = 0;
let permissionTitles = [];
let permissionResponder = () => ({ outcome: { outcome: "selected", optionId: "allow_once" } });

/**
 * Boot an agent for one scenario.
 * `hookFiles(dir)` → { "name.sh": "<content>" } written into the config dir.
 * `hooks` is the `hooks` config section (use __DIR__/__CWD__ placeholders).
 */
async function withAgent(name, opts, drive) {
  const dir = mkdtempSync(join(workRoot, `${name}-`));
  const cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
  // Pre-seed project memory so the first prompt doesn't trigger the project
  // initialization turn (its permission prompt would pollute permission counts).
  writeFileSync(join(cwd, "AGENTS.md"), "# 测试项目\n");
  mkdirSync(join(cwd, ".zhente"), { recursive: true });
  writeFileSync(join(cwd, ".zhente", "memory.md"), "# 记忆\n");
  for (const [file, content] of Object.entries(opts.hookFiles?.(dir) ?? {})) {
    const path = join(dir, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, { mode: 0o755 });
  }
  const config = {
    provider: {
      type: "openai",
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: "test-key",
      model: "test-model",
      maxTokens: 256,
    },
    agent: { permissionMode: opts.permissionMode ?? "confirm" },
    mcp: { enabled: false },
    skills: { enabled: false },
    hooks: opts.hooks,
  };
  // Some scenarios need project files (`.zhente/hooks.json`) to exist *before*
  // newSession — session_start and hook path resolution happen at session setup.
  opts.prepareCwd?.(cwd, dir);
  const configPath = join(dir, "zhente.config.json");
  writeFileSync(
    configPath,
    JSON.stringify(config, null, 2).replaceAll("__DIR__", dir).replaceAll("__CWD__", cwd),
  );

  rounds = [];
  llmRequests = [];
  permissionCalls = 0;
  permissionTitles = [];
  permissionResponder = opts.onPermission ?? (() => ({ outcome: { outcome: "selected", optionId: "allow_once" } }));

  const child = spawn("node", [join(root, "dist/index.js"), "--config", configPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ZHENTE_LOG_DIR: join(dir, "logs"), ZHENTE_LOG_FILE: "" },
  });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));

  const updates = [];
  const client = {
    async sessionUpdate(p) {
      updates.push(p.update);
    },
    async requestPermission(params) {
      permissionCalls++;
      permissionTitles.push(params?.toolCall?.title ?? "");
      return permissionResponder();
    },
  };
  const conn = new ClientSideConnection(() => client, ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: {}, terminal: false },
  });
  const session = await conn.newSession({ cwd, mcpServers: [] });

  const ctx = {
    dir,
    cwd,
    updates,
    conn,
    sessionId: session.sessionId,
    logs: () => readLogs(join(dir, "logs")),
    stderr: () => stderr,
    read: (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : null),
    readCwd: (rel) => (existsSync(join(cwd, rel)) ? readFileSync(join(cwd, rel), "utf8") : null),
    readJson: (rel) => (ctx.read(rel) === null ? null : JSON.parse(ctx.read(rel))),
    readJsonl: (rel) => (ctx.read(rel) === null ? null : ctx.read(rel).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))),
    toolMessages: () => (llmRequests.at(-1)?.messages ?? []).filter((m) => m.role === "tool").map((m) => m.content ?? ""),
    results: () =>
      updates
        .filter((u) => u.sessionUpdate === "tool_call_update" || (u.sessionUpdate === "tool_call" && u.status === "failed"))
        .map((u) => u.content?.[0]?.content?.text ?? ""),
    toolCalls: () => updates.filter((u) => u.sessionUpdate === "tool_call"),
    text: () =>
      updates
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => u.content.text)
        .join(""),
    prompt: (text) => conn.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text }] }),
  };

  try {
    await drive(ctx);
  } finally {
    child.kill("SIGKILL");
  }
  await new Promise((r) => setTimeout(r, 30));
  return ctx;
}

function readLogs(dir) {
  try {
    return readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
  } catch {
    return "";
  }
}

/** Write stdin payload to a jsonl file, then apply the given shell body. */
const dumpPayload = (dir, event) =>
  `cat > /tmp/zhente-hook-payload.json 2>/dev/null || true\ncat /tmp/zhente-hook-payload.json >> "${dir}/${event}.jsonl"\n`;

// ---------------------------------------------------------------------------

// 1) hooks.enabled:false ⇒ hook never spawned (zero overhead).
await withAgent(
  "disabled",
  {
    hooks: {
      enabled: false,
      onError: "allow",
      events: { session_start: [{ name: "s1", command: "sh __DIR__/s1.sh" }] },
    },
    hookFiles: (dir) => ({ "s1.sh": `#!/bin/sh\necho ran > "${dir}/sentinel"\n` }),
    permissionMode: "auto",
  },
  async (ctx) => {
    console.error("[1] hooks.enabled:false");
    rounds = [{ content: "好的" }];
    const res = await ctx.prompt("你好");
    ok(res.stopReason === "end_turn", "turn 正常结束");
    ok(ctx.read("sentinel") === null, "hook 命令完全没有被执行（无哨兵文件）");
  },
);

// 2) pre_tool_use deny (stdout JSON): bash not executed, no permission prompt.
await withAgent(
  "deny-stdout",
  {
    hooks: {
      enabled: true,
      onError: "allow",
      events: {
        pre_tool_use: [
          {
            name: "deny-bash",
            matcher: "^bash$",
            command: `sh __DIR__/deny.sh`,
          },
        ],
      },
    },
    hookFiles: (dir) => ({
      "deny.sh": `#!/bin/sh\n${dumpPayload(dir, "pre")}printf '%s\\n' '{"decision":"deny","reason":"禁止执行该命令"}'\n`,
    }),
  },
  async (ctx) => {
    console.error("[2] pre_tool_use deny (stdout JSON)");
    rounds = [
      { toolCalls: [{ name: "bash", arguments: { command: `echo hi > "${ctx.dir}/bash-sentinel"` } }] },
      { content: "收到" },
    ];
    const res = await ctx.prompt("跑个命令");
    ok(res.stopReason === "end_turn", "turn 继续（工具失败不影响收敛）");
    ok(ctx.read("bash-sentinel") === null, "bash 确实没有执行");
    ok(permissionCalls === 0, "deny 优先于权限确认（没有弹窗）");
    const failed = ctx.toolCalls().filter((u) => u.status === "failed");
    ok(failed.length === 1, "客户端收到 tool_call failed");
    ok(
      ctx.results().some((t) => t.includes("Error: 被 hook deny-bash 拒绝：禁止执行该命令")),
      `tool result 含格式化后的拒绝原因，实际: ${JSON.stringify(ctx.results())}`,
    );
    const payload = ctx.readJsonl("pre.jsonl")?.[0];
    ok(payload?.hook_event_name === "pre_tool_use", "stdin 信封含 hook_event_name");
    ok(payload?.tool_name === "bash" && payload?.tool_input?.command?.includes("bash-sentinel"), "payload 带工具名与已校验参数");
    ok(payload?.session_id === ctx.sessionId && payload?.cwd === ctx.cwd, "payload 带 session_id / cwd");
    ok(payload?.permission_mode === "confirm" && typeof payload?.timestamp === "string", "payload 带 permission_mode / timestamp");
    ok(ctx.logs().includes("被 hook 拒绝"), "日志记录了拒绝");
  },
);

// 3) pre_tool_use deny via exit 2 + stderr reason.
await withAgent(
  "deny-exit2",
  {
    hooks: {
      enabled: true,
      events: { pre_tool_use: [{ name: "deny2", matcher: "^bash$", command: "sh __DIR__/deny2.sh" }] },
    },
    hookFiles: () => ({
      "deny2.sh": `#!/bin/sh\necho "禁止删除根目录" >&2\nexit 2\n`,
    }),
  },
  async (ctx) => {
    console.error("[3] pre_tool_use deny (exit 2 + stderr)");
    rounds = [{ toolCalls: [{ name: "bash", arguments: { command: "rm -rf /" } }] }, { content: "明白" }];
    await ctx.prompt("删除根目录");
    ok(
      ctx.results().some((t) => t.includes("禁止删除根目录")),
      `exit 2 的 stderr 成为拒绝原因，实际: ${JSON.stringify(ctx.results())}`,
    );
  },
);

// 4) updatedInput: rewritten args drive execution, rawInput/title/tool result.
await withAgent(
  "updated-input",
  {
    hooks: {
      enabled: true,
      events: { pre_tool_use: [{ name: "rewrite", matcher: "^write_file$", command: "sh __DIR__/rewrite.sh" }] },
    },
    hookFiles: () => ({
      "rewrite.sh": `#!/bin/sh\ninput=$(cat)\nprintf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);const i={...p.tool_input,path:"b.txt"};console.log(JSON.stringify({hookSpecificOutput:{updatedInput:i}}))})'\n`,
    }),
    permissionMode: "auto",
  },
  async (ctx) => {
    console.error("[4] updatedInput 生效");
    rounds = [
      { toolCalls: [{ name: "write_file", arguments: { path: "a.txt", content: "REWRITTEN" } }] },
      { content: "写完了" },
    ];
    await ctx.prompt("写文件");
    ok(ctx.readCwd("b.txt") === "REWRITTEN", "实际写入的是改写后的 b.txt");
    ok(ctx.readCwd("a.txt") === null, "原参数 a.txt 未被使用");
    const call = ctx.toolCalls().find((u) => u.status === "in_progress");
    ok(call?.rawInput?.path === "b.txt", `rawInput 是最终参数，实际: ${JSON.stringify(call?.rawInput)}`);
    ok(String(call?.title).includes("b.txt"), `title 用最终参数生成，实际: ${call?.title}`);
    ok(
      ctx.results().some((t) => t.includes("b.txt")),
      "tool result 与实际执行一致",
    );
  },
);

// 5) invalid updatedInput ⇒ not executed, warn logged.
await withAgent(
  "bad-update",
  {
    hooks: {
      enabled: true,
      events: { pre_tool_use: [{ name: "bad", matcher: "^write_file$", command: "sh __DIR__/bad.sh" }] },
    },
    hookFiles: () => ({
      "bad.sh": `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '{"hookSpecificOutput":{"updatedInput":{"path":123,"content":"x"}}}'\n`,
    }),
    permissionMode: "auto",
  },
  async (ctx) => {
    console.error("[5] updatedInput 非法");
    rounds = [{ toolCalls: [{ name: "write_file", arguments: { path: "ok.txt", content: "OK" } }] }, { content: "嗯" }];
    await ctx.prompt("写文件");
    ok(ctx.readCwd("ok.txt") === null, "被污染的输入没有进入执行");
    ok(
      ctx.results().some((t) => t.includes("改写的参数不合法")),
      `tool result 说明了非法改写，实际: ${JSON.stringify(ctx.results())}`,
    );
    ok(ctx.logs().includes("改写的 tool_input 非法"), "有 warn 日志");
  },
);

// 6) allow does not skip session/request_permission.
await withAgent(
  "allow-keeps-permission",
  {
    hooks: {
      enabled: true,
      events: { pre_tool_use: [{ name: "allow", matcher: "^write_file$", command: "sh __DIR__/allow.sh" }] },
    },
    hookFiles: () => ({ "allow.sh": `#!/bin/sh\ncat > /dev/null\necho '{"decision":"allow"}'\n` }),
  },
  async (ctx) => {
    console.error("[6] allow 不跳过权限");
    rounds = [{ toolCalls: [{ name: "write_file", arguments: { path: "c.txt", content: "C" } }] }, { content: "好" }];
    await ctx.prompt("写 c.txt");
    ok(permissionCalls === 1, `仍然发生了一次权限确认（实际 ${permissionCalls}）`);
    ok(ctx.readCwd("c.txt") === "C", "批准后正常执行");
  },
);

// 7) ask overrides a remembered "always allow".
await withAgent(
  "ask-overrides-memory",
  {
    hooks: {
      enabled: true,
      events: { pre_tool_use: [{ name: "asker", matcher: "^write_file$", command: "sh __DIR__/asker.sh" }] },
    },
    hookFiles: (dir) => ({
      "asker.sh": `#!/bin/sh\ncat > /dev/null\nif [ -f "${dir}/used" ]; then printf '%s\\n' '{"decision":"ask","reason":"写文件需要复核"}'; else touch "${dir}/used"; echo '{"decision":"allow"}'; fi\n`,
    }),
  },
  async (ctx) => {
    console.error("[7] ask 覆盖权限记忆");
    // 1st call: hook allows, user answers "always allow" → memory written.
    permissionResponder = () => ({ outcome: { outcome: "selected", optionId: "allow_always" } });
    rounds = [
      { toolCalls: [{ name: "write_file", arguments: { path: "m1.txt", content: "1" } }] },
      { content: "好" },
    ];
    await ctx.prompt("写 m1");
    ok(permissionCalls === 1 && ctx.readCwd("m1.txt") === "1", "第一次：allow + always allow");

    // 2nd call: hook returns ask → must prompt again despite the memory.
    permissionResponder = () => ({ outcome: { outcome: "selected", optionId: "reject_once" } });
    rounds = [
      { toolCalls: [{ name: "write_file", arguments: { path: "m2.txt", content: "2" } }] },
      { content: "好" },
    ];
    await ctx.prompt("写 m2");
    ok(permissionCalls === 2, `always allow 被忽略，仍然弹窗（实际 ${permissionCalls} 次）`);
    ok(ctx.readCwd("m2.txt") === null, "用户拒绝后没有执行");
    ok(ctx.toolMessages().some((t) => t.includes("用户拒绝执行此工具")), "按既有拒绝路径回填 tool result（历史与 needsPermission 工具同一文案）");
  },
);

// 8) post_tool_use: context on success and failure; deny ignored.
await withAgent(
  "post-tool",
  {
    hooks: {
      enabled: true,
      events: {
        post_tool_use: [{ name: "post-ctx", command: "sh __DIR__/post.sh" }],
      },
    },
    hookFiles: (dir) => ({
      "post.sh": `#!/bin/sh\n${dumpPayload(dir, "post")}printf '%s\\n' '{"hookSpecificOutput":{"additionalContext":"LINT-OK"}}'\n`,
    }),
    permissionMode: "auto",
  },
  async (ctx) => {
    console.error("[8] post_tool_use additionalContext");
    rounds = [
      { toolCalls: [{ name: "write_file", arguments: { path: "p.txt", content: "P" } }] },
      { toolCalls: [{ name: "bash", arguments: { command: "exit 3" } }] },
      { content: "结束" },
    ];
    await ctx.prompt("写文件再跑个失败命令");
    const results = ctx.results();
    ok(
      results.some((t) => t.includes("LINT-OK")),
      `成功路径的 tool result 末尾带 hook 上下文，实际: ${JSON.stringify(results)}`,
    );
    const payloads = ctx.readJsonl("post.jsonl") ?? [];
    ok(payloads.length === 2, `成功与失败两条路径都触发（实际 ${payloads.length} 次）`);
    ok(payloads[1]?.tool_error === true, "失败路径 payload 带 tool_error=true");
    ok(payloads[1]?.tool_output?.includes("exit 3") || payloads[1]?.tool_error === true, "失败路径带工具输出");
    ok(typeof payloads[0]?.tool_elapsed_ms === "number", "payload 带 tool_elapsed_ms");
  },
);

// 9) user_prompt_submit deny ⇒ refusal, no LLM call, no user message.
await withAgent(
  "prompt-deny",
  {
    hooks: {
      enabled: true,
      events: {
        user_prompt_submit: [{ name: "secret-scan", command: "sh __DIR__/scan.sh", onError: "deny" }],
      },
    },
    hookFiles: (dir) => ({
      "scan.sh": `#!/bin/sh\n${dumpPayload(dir, "prompt")}cat /tmp/zhente-hook-payload.json | grep -q "SECRET" && { echo "prompt 含密钥" >&2; exit 2; }\nexit 0\n`,
    }),
  },
  async (ctx) => {
    console.error("[9] user_prompt_submit deny");
    rounds = [{ content: "第一次回复" }];
    const denied = await ctx.prompt("这是 SECRET 内容");
    ok(denied.stopReason === "refusal", `deny 返回 refusal（实际 ${denied.stopReason}）`);
    ok(llmRequests.length === 0, "没有调用 LLM");
    ok(ctx.text().includes("被 hook secret-scan 拒绝"), "客户端收到拦截说明");

    // Next prompt is allowed → history must contain only that one user message.
    rounds = [{ content: "第二次回复" }];
    const res = await ctx.prompt("正常问题");
    ok(res.stopReason === "end_turn", "下一条 prompt 正常执行");
    const users = llmRequests[0].messages.filter((m) => m.role === "user");
    ok(users.length === 1 && users[0].content === "正常问题", "被拒的 prompt 没有进入历史");
    ok(ctx.readJsonl("prompt.jsonl")[0].prompt === "这是 SECRET 内容", "payload.prompt 是模型将收到的文本");
  },
);

// 10) turn_end + cancelled turn_end.
await withAgent(
  "turn-end",
  {
    hooks: {
      enabled: true,
      events: { turn_end: [{ name: "audit", command: "sh __DIR__/audit.sh" }] },
    },
    hookFiles: (dir) => ({ "audit.sh": `#!/bin/sh\n${dumpPayload(dir, "turn")}exit 0\n` }),
    permissionMode: "auto",
  },
  async (ctx) => {
    console.error("[10] turn_end / cancelled");
    rounds = [{ content: "正常结束" }];
    await ctx.prompt("正常");
    const first = ctx.readJsonl("turn.jsonl")?.at(-1);
    ok(first?.stop_reason === "end_turn" && first?.turn_kind === "main", "turn_end 带 stop_reason / turn_kind");
    ok(first?.iterations >= 1 && typeof first?.elapsed_ms === "number", "turn_end 带 iterations / elapsed_ms");

    rounds = [{ hang: true }];
    const pending = ctx.prompt("永远不会回复");
    await new Promise((r) => setTimeout(r, 150));
    await ctx.conn.cancel({ sessionId: ctx.sessionId });
    const cancelled = await pending;
    ok(cancelled.stopReason === "cancelled", "取消返回 cancelled");
    const last = ctx.readJsonl("turn.jsonl")?.at(-1);
    ok(last?.stop_reason === "cancelled", `取消后仍有一次 turn_end（实际 ${last?.stop_reason}）`);
  },
);

// 11) timeout: killed, onError decides, turn not stuck.
await withAgent(
  "timeout",
  {
    hooks: {
      enabled: true,
      timeoutMs: 100,
      onError: "allow",
      events: { pre_tool_use: [{ name: "slow", matcher: "^bash$", command: "sh __DIR__/slow.sh" }] },
    },
    hookFiles: () => ({ "slow.sh": `#!/bin/sh\ncat > /dev/null\nsleep 5\necho '{"decision":"deny","reason":"太慢了"}'\n` }),
    permissionMode: "auto",
  },
  async (ctx) => {
    console.error("[11] 超时按 onError 处理");
    rounds = [{ toolCalls: [{ name: "bash", arguments: { command: `echo ok > "${ctx.dir}/slow-sentinel"` } }] }, { content: "好" }];
    const startedAt = Date.now();
    const res = await ctx.prompt("跑命令");
    const elapsed = Date.now() - startedAt;
    ok(res.stopReason === "end_turn", "turn 没有被卡死");
    ok(elapsed < 3000, `总耗时 ${elapsed}ms < 3s`);
    ok(ctx.read("slow-sentinel") !== null, "onError=allow ⇒ 工具照常执行");
    ok(ctx.logs().includes("hook 超时"), "日志记录了超时");
  },
);

await withAgent(
  "timeout-deny",
  {
    hooks: {
      enabled: true,
      timeoutMs: 100,
      onError: "deny",
      events: { pre_tool_use: [{ name: "slow2", matcher: "^bash$", command: "sh __DIR__/slow2.sh" }] },
    },
    hookFiles: () => ({ "slow2.sh": `#!/bin/sh\ncat > /dev/null\nsleep 5\n` }),
    permissionMode: "auto",
  },
  async (ctx) => {
    console.error("[11b] 超时 + onError=deny ⇒ 拒绝");
    rounds = [{ toolCalls: [{ name: "bash", arguments: { command: `echo ok > "${ctx.dir}/slow2-sentinel"` } }] }, { content: "好" }];
    await ctx.prompt("跑命令");
    ok(ctx.read("slow2-sentinel") === null, "fail-closed 生效，工具没有执行");
  },
);

// 12) matcher.
await withAgent(
  "matcher",
  {
    hooks: {
      enabled: true,
      events: { pre_tool_use: [{ name: "only-bash", matcher: "^bash$", command: "sh __DIR__/m.sh" }] },
    },
    hookFiles: (dir) => ({ "m.sh": `#!/bin/sh\n${dumpPayload(dir, "matched")}exit 0\n` }),
    permissionMode: "auto",
  },
  async (ctx) => {
    console.error("[12] matcher");
    writeFileSync(join(ctx.cwd, "read-me.txt"), "内容");
    rounds = [{ toolCalls: [{ name: "read_file", arguments: { path: "read-me.txt" } }] }, { content: "好" }];
    await ctx.prompt("读文件");
    ok(ctx.read("matched.jsonl") === null, "不匹配的工具不会触发 hook");
    rounds = [{ toolCalls: [{ name: "bash", arguments: { command: "echo hi" } }] }, { content: "好" }];
    await ctx.prompt("跑命令");
    ok(ctx.readJsonl("matched.jsonl")?.[0]?.tool_name === "bash", "匹配的工具会触发 hook");
  },
);

// 13) history consistency after denials (tool_calls/tool pairing).
await withAgent(
  "history",
  {
    hooks: {
      enabled: true,
      events: {
        pre_tool_use: [
          { name: "deny-bash", matcher: "^bash$", command: "sh __DIR__/d.sh" },
          { name: "bad-write", matcher: "^write_file$", command: "sh __DIR__/b.sh" },
        ],
      },
    },
    hookFiles: () => ({
      "d.sh": `#!/bin/sh\ncat > /dev/null\necho '{"decision":"deny","reason":"nope"}'\n`,
      "b.sh": `#!/bin/sh\ncat > /dev/null\necho '{"hookSpecificOutput":{"updatedInput":{"path":9}}}'\n`,
    }),
    permissionMode: "auto",
  },
  async (ctx) => {
    console.error("[13] 历史一致性（tool_calls 配对）");
    writeFileSync(join(ctx.cwd, "ok.txt"), "ok");
    rounds = [
      { toolCalls: [{ name: "bash", arguments: { command: "echo never" } }] },
      { toolCalls: [{ name: "write_file", arguments: { path: "x.txt", content: "x" } }] },
      { content: "第一轮结束" },
      { toolCalls: [{ name: "read_file", arguments: { path: "ok.txt" } }] },
      { content: "第二轮结束" },
    ];
    await ctx.prompt("第一轮");
    const second = await ctx.prompt("第二轮");
    ok(second.stopReason === "end_turn", "拒绝之后下一轮仍能执行");
    const messages = llmRequests.at(-1).messages;
    const callIds = messages.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((t) => t.id) : []));
    const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    ok(callIds.length > 0 && callIds.every((id) => answered.has(id)), "每个 tool_call 都有配对的 tool 响应（无 400 形状）");
  },
);

// 14) auto + ask ⇒ still prompts (D14).
await withAgent(
  "auto-ask",
  {
    hooks: {
      enabled: true,
      events: { pre_tool_use: [{ name: "asker", matcher: "^write_file$", command: "sh __DIR__/a.sh" }] },
    },
    hookFiles: () => ({ "a.sh": `#!/bin/sh\ncat > /dev/null\necho '{"decision":"ask","reason":"auto 下也要问"}'\n` }),
    permissionMode: "auto",
  },
  async (ctx) => {
    console.error("[14] auto + ask（D14）");
    permissionResponder = () => ({ outcome: { outcome: "selected", optionId: "reject_once" } });
    rounds = [{ toolCalls: [{ name: "write_file", arguments: { path: "q.txt", content: "Q" } }] }, { content: "好" }];
    await ctx.prompt("写文件");
    ok(permissionCalls === 1, `auto 模式下仍然弹窗（实际 ${permissionCalls} 次）`);
    ok(ctx.readCwd("q.txt") === null, "拒绝后没有执行");
    ok(String(permissionTitles[0]).includes("auto 下也要问"), `弹窗标题带 hook 的 ask 原因与名字，实际: ${permissionTitles[0]}`);
  },
);

// 15) read-only tool (needsPermission:false) + ask ⇒ still prompts (D14).
await withAgent(
  "readonly-ask",
  {
    hooks: {
      enabled: true,
      events: { pre_tool_use: [{ name: "guard-read", matcher: "^read_file$", command: "sh __DIR__/r.sh" }] },
    },
    hookFiles: () => ({ "r.sh": `#!/bin/sh\ncat > /dev/null\necho '{"decision":"ask","reason":"读取敏感路径"}'\n` }),
    permissionMode: "auto",
  },
  async (ctx) => {
    console.error("[15] 只读工具 + ask（D14）");
    writeFileSync(join(ctx.cwd, "secret.txt"), "top-secret");
    permissionResponder = () => ({ outcome: { outcome: "selected", optionId: "reject_once" } });
    rounds = [{ toolCalls: [{ name: "read_file", arguments: { path: "secret.txt" } }] }, { content: "好" }];
    await ctx.prompt("读 secret.txt");
    ok(permissionCalls === 1, `needsPermission:false 的 read_file 也弹窗（实际 ${permissionCalls} 次）`);
    ok(!ctx.results().some((t) => t.includes("top-secret")), "拒绝后没有读到内容");
    ok(ctx.toolMessages().some((t) => t.includes("用户拒绝执行此工具")), "沿用既有拒绝文案");
  },
);

// 16) relative command resolves against the config-file dir, not session cwd (D15).
await withAgent(
  "relative-base",
  {
    hooks: {
      enabled: true,
      events: {
        pre_tool_use: [{ name: "rel", matcher: "^bash$", command: "./hooks/guard.sh" }],
        session_start: [{ name: "inline", command: "sh __DIR__/inline.sh" }],
      },
    },
    hookFiles: (dir) => ({
      "hooks/guard.sh": `#!/bin/sh\ncat > /dev/null\necho ran > "${dir}/config-dir-sentinel"\nexit 0\n`,
      "inline.sh": `#!/bin/sh\ncat > /dev/null\necho ran > "${dir}/inline-sentinel"\n`,
    }),
    permissionMode: "auto",
  },
  async (ctx) => {
    console.error("[16] 相对路径基准 = 配置目录（D15）");
    // Trap: a same-named script inside the *session cwd* (the opened project).
    mkdirSync(join(ctx.cwd, "hooks"), { recursive: true });
    writeFileSync(join(ctx.cwd, "hooks", "guard.sh"), `#!/bin/sh\necho pwned > "${ctx.dir}/trap-sentinel"\n`, { mode: 0o755 });
    rounds = [{ toolCalls: [{ name: "bash", arguments: { command: "echo hi" } }] }, { content: "好" }];
    await ctx.prompt("跑命令");
    ok(ctx.read("config-dir-sentinel") !== null, "执行的是配置文件目录下的脚本");
    ok(ctx.read("trap-sentinel") === null, "session cwd 里的同名陷阱脚本没有被执行");
    ok(ctx.read("inline-sentinel") !== null, "内联命令（sh …）未被误判为路径形态");
  },
);

// 17) path-like command that does not exist ⇒ fail fast at load time (D15).
{
  console.error("[17] 路径形态命令不存在 ⇒ 加载期 fail fast");
  const dir = mkdtempSync(join(workRoot, "missing-"));
  const configPath = join(dir, "zhente.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      provider: { type: "openai", baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "m" },
      mcp: { enabled: false },
      skills: { enabled: false },
      hooks: { enabled: true, events: { pre_tool_use: [{ name: "gone", command: "./hooks/nope.sh" }] } },
    }),
  );
  const child = spawn("node", [join(root, "dist/index.js"), "--config", configPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  await new Promise((r) => setTimeout(r, 1200));
  child.kill("SIGKILL");
  const missingLine = stderr.split("\n").find((line) => line.includes("可执行文件不存在")) ?? "";
  ok(
    missingLine.includes("nope.sh") && missingLine.includes("hooks.events.pre_tool_use"),
    `启动期 fail fast 且错误信息可定位: ${missingLine.trim()}`,
  );
  ok(!stderr.includes("ACP agent 就绪"), "没有进入 ACP 会话（turn 之前就失败）");
}


// 18) project-level hooks file is OFF by default (D4: supply-chain guard).
await withAgent(
  "project-default-off",
  {
    hooks: { enabled: true, events: {} },
    permissionMode: "auto",
    prepareCwd: (cwd) => {
      mkdirSync(join(cwd, ".zhente"), { recursive: true });
      writeFileSync(
        join(cwd, ".zhente", "hooks.json"),
        JSON.stringify({ events: { pre_tool_use: [{ name: "repo", matcher: "^bash$", command: "sh -c 'echo pwned'", onError: "deny" }] } }),
      );
    },
  },
  async (ctx) => {
    console.error("[18] 项目级 hooks 默认关闭（D4）");
    rounds = [{ toolCalls: [{ name: "bash", arguments: { command: `echo ok > "${ctx.dir}/repo-sentinel"` } }] }, { content: "好" }];
    await ctx.prompt("跑命令");
    ok(ctx.read("repo-sentinel") !== null, "未开启 projectFile ⇒ 仓库里的 hooks.json 完全不生效");
  },
);

// 19) project-level hooks: relative to the project root, clamped (L3).
await withAgent(
  "project-enabled",
  {
    hooks: {
      enabled: true,
      onError: "deny", // 项目级条目不能放宽它（只能更严）
      events: {},
      projectFile: { enabled: true },
    },
    permissionMode: "auto",
    prepareCwd: (cwd, dir) => {
      mkdirSync(join(cwd, ".zhente", "hooks"), { recursive: true });
      writeFileSync(
        join(cwd, ".zhente", "hooks", "start.sh"),
        `#!/bin/sh\ncat > /dev/null\necho ran > "${dir}/project-start-sentinel"\n`,
        { mode: 0o755 },
      );
      // 声明 onError:"allow" 也放宽不了配置级的 "deny" ⇒ 失败即拒绝。
      writeFileSync(
        join(cwd, ".zhente", "hooks", "guard.sh"),
        `#!/bin/sh\ncat > /dev/null\nexit 1\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(cwd, ".zhente", "hooks.json"),
        JSON.stringify({
          events: {
            session_start: [{ name: "repo-start", command: ".zhente/hooks/start.sh" }],
            pre_tool_use: [{ name: "repo-guard", matcher: "^bash$", command: ".zhente/hooks/guard.sh", onError: "allow" }],
          },
        }),
      );
    },
  },
  async (ctx) => {
    console.error("[19] 项目级 hooks（相对项目根 + 钳制）");
    ok(ctx.read("project-start-sentinel") !== null, "session_start 项目级 hook 按项目根解析相对路径并执行");
    rounds = [{ toolCalls: [{ name: "bash", arguments: { command: `echo ok > "${ctx.dir}/guard-sentinel"` } }] }, { content: "好" }];
    await ctx.prompt("跑命令");
    ok(ctx.read("guard-sentinel") === null, "项目级 onError 不能放宽配置级的 deny（失败 ⇒ 拒绝）");
    ok(ctx.logs().includes("已启用项目级 hooks"), "加载时 warn 提示（让用户知道自己信任了该仓库）");
  },
);

for (const res of heldOpen) res.destroy();
server.close();
console.error(`\nHOOK SMOKE OK ✅ (${checks} 项断言)`);
process.exit(0);
