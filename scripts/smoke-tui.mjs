// Headless smoke test for the TUI layer.
//
// The full interactive UI needs a pty, so this drives what can run headless:
//   1. pure modules: commands / theme / wcwidth / input / model (plan,
//      tool-row failed-direct, notification mapping)
//   2. in-process ACP pairing (bridge.ts + ZhenTeAgent + mock provider):
//      initialize -> newSession -> prompt with a *dynamic* permission flow
//      (project-init has 3 options; tool permission has 4 — asserting the
//      dialog is numbered from the returned options, B4) -> streaming lands in
//      the ChatModel -> end_turn
//   3. N1: setSessionMode clears the session's remembered permissions
//      (observed via the agent log line)
//   4. cancel during a pending permission resolves the turn as "cancelled"
//      (A7)
//
// Run: npm run build && node scripts/smoke-tui.mjs

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { TuiBridge } from "../dist/tui/bridge.js";
import { ChatModel } from "../dist/tui/model.js";
import { parseCommand, completeLine, helpLines } from "../dist/tui/commands.js";
import { makeTheme } from "../dist/tui/theme.js";
import { stringWidth, truncateWidth } from "../dist/tui/wcwidth.js";
import { InputLine } from "../dist/tui/input.js";
import { logger } from "../dist/logger.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const workdir = mkdtempSync(join(tmpdir(), "zhente-tui-smoke-"));
const logDir = mkdtempSync(join(tmpdir(), "zhente-tui-logs-"));
logger.configure({ dir: logDir, level: "info" });

let passed = 0;
const ok = (name, cond, extra = "") => {
  assert.ok(cond, `${name}${extra ? " :: " + extra : ""}`);
  passed += 1;
  console.error(`✓ ${name}`);
};

// ───────────────────────── pure modules ─────────────────────────
{
  const c = parseCommand("/model", { modelIds: ["a", "b"] });
  ok("parse /model noarg -> picker", c.isCommand && c.action?.kind === "show-model-picker");
  const c2 = parseCommand("/model deepseek-v4-pro", { modelIds: ["a", "b"] });
  ok("parse /model arg", c2.isCommand && c2.action?.kind === "set-model" && c2.action.modelId === "deepseek-v4-pro");
  const c3 = parseCommand("/access", { modelIds: [] });
  ok("parse /access noarg -> status", c3.action?.kind === "show-access-status");
  const c4 = parseCommand("/access full", { modelIds: [] });
  ok("parse /access full -> confirm dialog", c4.action?.kind === "request-full-access");
  const c5 = parseCommand("/access standard", { modelIds: [] });
  ok("parse /access standard -> set confirm", c5.action?.kind === "set-mode" && c5.action.modeId === "confirm");
  const c6 = parseCommand("/acess auto", { modelIds: [] });
  ok("alias /acess -> /access", c6.action?.kind === "request-full-access");
  const c7 = parseCommand("/permissions reset", { modelIds: [] });
  ok("parse /permissions reset", c7.action?.kind === "permissions-reset");
  const c8 = parseCommand("//not a command", { modelIds: [] });
  ok("// is plain text", c8.isCommand === false);
  const c9 = parseCommand("/wat", { modelIds: [] });
  ok("unknown command", c9.action?.kind === "unknown-command");
  ok("help lists /access as danger", helpLines().some((l) => l.kind === "danger" && l.text.includes("/access")));

  const cands = completeLine("/model deep", { modelIds: ["deepseek-v4-flash", "deepseek-v4-pro"] });
  ok("tab completes /model ids", cands.includes("/model deepseek-v4-flash") && cands.includes("/model deepseek-v4-pro"));
  const cc = completeLine("/ac", { modelIds: [] });
  ok("tab completes command names", cc.includes("/access"));
}

{
  const theme = makeTheme({ crt: false, noColor: true });
  ok("NO_COLOR theme disables paint", theme.enabled === false && theme.green === "");
  const t2 = makeTheme({ crt: true, noColor: false });
  ok("crt theme sets black bg", t2.bg === "\x1b[40m");
  ok("wcwidth CJK=2", stringWidth("中文") === 4 && stringWidth("ab") === 2);
  const tr = truncateWidth("abcd中文", 6, "~");
  ok("truncate by display width", tr.truncated && stringWidth(tr.text) <= 6);
}

{
  const il = new InputLine();
  il.setText("hello");
  il.insert(" 中文");
  ok("input insert at end", il.text === "hello 中文");
  il.moveLeft();
  il.backspace();
  // cursor 在“文”前，backspace 删光标前字符“中”
  ok("input backspace by code point", il.text === "hello 文");
  il.setText("hi😀");
  il.backspace();
  ok("surrogate pair deleted whole (no lone half)", il.text === "hi" && il.isEmpty() === false && il.text.length === 2);
  il.setText("abc");
  il.moveToStart();
  il.deleteForward();
  ok("delete forward", il.text === "bc");
  il.setText("");
  il.commit();
  ok("input commit empty returns", il.text === "" && il.isEmpty());
}

{
  const m = new ChatModel();
  m.applyUpdate({ sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } });
  m.applyUpdate({ sessionId: "s", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "执行 ls", kind: "execute", status: "failed", rawInput: { command: "ls" } } });
  ok("failed-direct tool row lands", m.entries.some((e) => e.kind === "tool" && e.status === "failed"));
  ok("N2 no pending spinner for failed-direct", m.toolRows().every((r) => r.status !== "in_progress"));
  m.applyUpdate({ sessionId: "s", update: { sessionUpdate: "plan", entries: [{ content: "x", priority: "high", status: "in_progress" }] } });
  m.applyUpdate({ sessionId: "s", update: { sessionUpdate: "plan", entries: [{ content: "y", priority: "low", status: "completed" }] } });
  const plans = m.entries.filter((e) => e.kind === "plan");
  ok("plan is replaceable (single block)", plans.length === 1 && plans[0].kind === "plan" && plans[0].entries[0].content === "y");
  m.finalizeStream();
  ok("finalize moves streaming to assistant", m.entries.some((e) => e.kind === "assistant" && e.text === "hi"));
}

// ───────────────── in-process ACP pairing ─────────────────
const events = [];
const config = {
  provider: {
    type: "mock",
    model: "mock-fast",
    models: [
      { modelId: "mock-fast", name: "Mock Fast" },
      { modelId: "mock-pro", name: "Mock Pro" },
    ],
    temperature: 0,
    maxTokens: 8192,
    requestTimeoutMs: 120000,
  },
  agent: { maxIterations: 40, permissionMode: "confirm", systemPrompt: null },
  mcp: { enabled: false, connectTimeoutMs: 15000 },
  skills: { enabled: false, dirs: [] },
};

const permissionLog = [];
const model = new ChatModel();
let permissionResponder = null;
let pendingRequest = null;
let promptResolve = null;
const events2 = [];
const model2 = new ChatModel();
let pendingPerm2 = null;

const bridge = new TuiBridge(config, {
  onSessionUpdate: (n) => {
    events.push(n.update.sessionUpdate);
    model.applyUpdate(n);
  },
  onPermissionRequest: (req, respond) => {
    pendingRequest = req;
    permissionResponder = respond;
    permissionLog.push({ title: req.toolCall.title, options: req.options.map((o) => ({ id: o.optionId, kind: o.kind })) });
    // Auto-drive like a human: project-init -> skip; everything else -> allow once.
    if (req.toolCall.title.includes("初始化项目记忆")) {
      const skip = req.options.find((o) => o.optionId === "skip");
      respond({ outcome: { outcome: "selected", optionId: skip ? "skip" : req.options[0].optionId } });
    } else {
      const once = req.options.find((o) => o.optionId === "allow_once");
      respond({ outcome: { outcome: "selected", optionId: once ? "allow_once" : req.options[0].optionId } });
    }
  },
});

const main = async () => {
  const init = await bridge.initialize();
  ok("initialize handshake", init.protocolVersion === 1);

  const session = await bridge.newSession(workdir);
  ok("newSession returns models/modes", !!session.sessionId && session.models?.availableModels.length === 2 && session.modes?.currentModeId === "confirm");

  // First prompt: triggers the project-init permission (3 options) in the temp dir.
  const res = await bridge.prompt(session.sessionId, "创建 hello.txt 并确认内容");
  ok("prompt end_turn", res.stopReason === "end_turn");
  const initPerm = permissionLog.find((p) => p.options.length === 3 && p.options.some((o) => o.id === "skip"));
  ok("project-init permission has 3 dynamic options (B4)", !!initPerm);
  const toolPerm = permissionLog.find((p) => p.options.length === 4);
  ok("tool permission has 4 options (B4)", !!toolPerm);
  const hello = readFileSync(join(workdir, "hello.txt"), "utf8");
  ok("agent ran write via bridge", hello === "hello from zhente\n");
  ok("events streamed to model", events.includes("agent_message_chunk") && events.includes("tool_call") && events.includes("tool_call_update"));
  model.finalizeStream();
  ok("chat model assistant finalized from stream", model.entries.some((e) => e.kind === "assistant" && e.text.length > 0));
  ok("tool row completed", model.toolRows().some((r) => r.status === "completed"));

  // session/set_model via bridge: unknown model -> invalidParams JSON-RPC error
  let unknownModelError = false;
  try {
    await bridge.setModel(session.sessionId, "nope");
  } catch (e) {
    // SDK rejects with { code, message: "Invalid params", data: { modelId: "未知模型: nope" } }
    const text = JSON.stringify(e ?? {});
    unknownModelError = text.includes("未知模型");
  }
  ok("unknown model rejected by agent (ext method)", unknownModelError);
  await bridge.setModel(session.sessionId, "mock-pro");
  ok("setModel accepted", true);

  // ── N1: setSessionMode clears remembered permissions ──
  // (the previous turn never chose "always", so simulate the memory by
  // checking the agent's log line after two set_mode calls)
  await bridge.setMode(session.sessionId, "auto");
  await bridge.setMode(session.sessionId, "confirm");
  await new Promise((r) => setTimeout(r, 50));
  const logs = readdirSync(logDir)
    .filter((f) => f.endsWith(".log"))
    .map((f) => readFileSync(join(logDir, f), "utf8"))
    .join("\n");
  ok("N1: setSessionMode cleared permission memory (agent log)", /permission memory cleared/.test(logs), "");

  // ── A7: cancel resolves a pending permission request & the turn returns cancelled ──
  // Second, fresh bridge (fresh agent -> fresh provider instance, mock steps
  // reset). New session in the now-initialized workdir: no project-init, but
  // the mock's first streamChat calls write_file -> a 4-option permission.
  // Hold the permission open, then cancel; the client MUST settle the pending
  // request (outcome cancelled) or the agent's ensurePermission never returns.
  const bridge2 = new TuiBridge(config, {
    onSessionUpdate: (n) => { events2.push(n.update.sessionUpdate); model2.applyUpdate(n); },
    onPermissionRequest: (req, respond) => {
      pendingPerm2 = { req, respond };
    },
  });
  // Pre-create project memory so the second session skips project-init and the
  // mock's first tool call (write_file, 4 permission options) is what we hold.
  writeFileSync(join(workdir, "AGENTS.md"), "# smoke\n");
  mkdirSync(join(workdir, ".zhente"), { recursive: true });
  writeFileSync(join(workdir, ".zhente", "memory.md"), "# smoke\n");
  await bridge2.initialize();
  const session2 = await bridge2.newSession(workdir);
  const p2 = bridge2.prompt(session2.sessionId, "再写一个文件 a.txt");
  // Wait until the permission request is actually pending.
  for (let i = 0; i < 100 && !pendingPerm2; i++) await new Promise((r) => setTimeout(r, 10));
  ok("A7: permission request arrives and is held", !!pendingPerm2);
  ok("A7: tool permission has dynamic options", pendingPerm2.req.options.length === 4);
  // Client cancels the turn: settle the pending permission as cancelled, then
  // send session/cancel.
  bridge2.cancelPendingPermission();
  await bridge2.cancel(session2.sessionId);
  const res2 = await p2;
  ok("A7: prompt resolves with cancelled after settle+cancel", res2.stopReason === "cancelled");
  ok("A7: tool row shows failed (rejected path)", model2.toolRows().some((r) => r.status === "failed"));
  await bridge2.shutdown();

  await bridge.shutdown();  await bridge.shutdown();
  console.error(`\nSMOKE-TUI OK ✅ (${passed} assertions)`);
  process.exit(0);
};

main().catch((e) => {
  console.error("SMOKE-TUI FAILED ❌");
  console.error(e);
  process.exit(1);
});
