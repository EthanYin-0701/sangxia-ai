/**
 * `sangxia tui` — terminal UI entry (tui/index.ts).
 *
 * Drives the same SangxiaAgent over an in-process ACP pair (bridge.ts), with
 * stdio belonging exclusively to the UI. Startup failures (non-TTY, missing
 * config, …) print a friendly message to stderr and exit non-zero — never a
 * raw stack (§3 C8 of plan/tui_support.md).
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiBridge } from "./bridge.js";
import { ChatModel } from "./model.js";
import { loadConfig, type Config } from "../config.js";
import { logger } from "../logger.js";
import { completeLine, parseCommand, type CommandAction } from "./commands.js";
import { InputLine } from "./input.js";
import { KeyReader, type Key } from "./keys.js";
import { QUIT_ARM_MS, QuitGate } from "./quit-gate.js";
import { makeTheme } from "./theme.js";
import { renderFrame, invalidateFrame, type DialogFrame, type Frame } from "./ui.js";
import { stringWidth } from "./wcwidth.js";
import type {
  ModelInfo,
  PermissionOption,
  RequestPermissionRequest,
  SessionNotification,
} from "@zed-industries/agent-client-protocol";

export interface TuiOptions {
  configPath?: string;
  crt: boolean;
}

/** cli argv -> options (only flags we understand; unknown flags are ignored). */
export function parseTuiArgs(argv: string[]): TuiOptions {
  const opts: TuiOptions = { crt: argv.includes("--crt") };
  const cfgIdx = argv.indexOf("--config");
  if (cfgIdx >= 0 && argv[cfgIdx + 1]) opts.configPath = argv[cfgIdx + 1];
  return opts;
}

const APP_NAME = "Sangxia";

export async function runTui(argv: string[]): Promise<number> {
  // ── 1. TTY guard (render needs stdout, keys need stdin - both must be TTY) ──
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "sangxia tui 需要真实终端（stdin 与 stdout 均须为 TTY）。可用 `script -q /dev/null sangxia tui` 包裹。\n",
    );
    return 1;
  }
  if ((process.env.TERM ?? "").toLowerCase() === "dumb") {
    process.stderr.write("TERM=dumb 下无法运行 TUI，请使用真实终端。\n");
    return 1;
  }

  // ── 2. options + config ──
  const opts = parseTuiArgs(argv);
  let config: Config;
  try {
    config = loadConfig(argv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`配置加载失败：${msg}\n`);
    process.stderr.write(
      "提示：sangxia tui 与 ACP 模式共用同一份配置（--config / SANGXIA_CONFIG / ./sangxia.config.json / ~/.config/sangxia/config.json）。\n",
    );
    return 1;
  }

  // ── 3. logger: TUI 下日志不进屏幕只进文件 ──
  const logDir = process.env.SANGXIA_LOG_DIR ?? join(tmpdir(), "sangxia-tui-logs");
  logger.configure({ stderr: false, level: "warn", dir: logDir });

  // ── 4. theme + alternate screen ──
  const noColor = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "";
  const theme = makeTheme({ crt: opts.crt, noColor });
  const stdout = process.stdout;
  // Bracketed paste: terminals wrap pasted text in ESC[200~…ESC[201~ so we can
  // distinguish it from typed keys (otherwise every pasted newline is an Enter).
  stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H\x1b[?2004h");

  let restored = false;
  const restoreTerminal = (): void => {
    if (restored) return;
    restored = true;
    stdout.write("\x1b[?2004l\x1b[?25h\x1b[?1049l");
  };
  process.on("exit", restoreTerminal);

  // ── 5. chat model + app state ──
  const model = new ChatModel();
  const input = new InputLine();
  const state = {
    sessionId: "" as string | null,
    cwd: process.cwd(),
    currentModelId: "",
    availableModels: [] as ModelInfo[],
    modeId: "confirm" as "confirm" | "auto",
    pendingModelSwitch: null as string | null,
    busy: false,
    scroll: 0,
    dialog: null as
      | { kind: "permission"; req: RequestPermissionRequest; selected: number }
      | { kind: "model-picker"; selected: number }
      | { kind: "confirm-full-access" }
      | null,
    quitting: false,
  };

  let renderQueued = false;
  const render = (): void => {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      if (state.quitting) return;
      paintFrame();
    });
  };

  const modeLabel = (): string =>
    state.modeId === "auto" ? "Full Access (auto)" : "Standard Access (confirm)";

  // ── Ctrl+C-while-idle quit gate (see quit-gate.ts) ──
  const quitGate = new QuitGate();
  let quitHint: string | null = null;
  let quitTimer: NodeJS.Timeout | null = null;

  /** Arm "press Ctrl+C again to exit" and show `hint` on the input row. */
  function armQuit(hint: string): void {
    quitGate.arm();
    quitHint = hint;
    if (quitTimer) clearTimeout(quitTimer);
    // Drop the hint when the window lapses (a later press only re-arms).
    quitTimer = setTimeout(() => {
      quitTimer = null;
      quitGate.reset();
      if (quitHint !== null) {
        quitHint = null;
        render();
      }
    }, QUIT_ARM_MS + 50);
    quitTimer.unref?.();
  }

  /** Disarm on any other key / when the UI moves on. */
  function disarmQuit(): void {
    if (quitTimer) {
      clearTimeout(quitTimer);
      quitTimer = null;
    }
    quitGate.reset();
    quitHint = null;
  }

  function paintFrame(): void {
    const rows = stdout.rows || 24; // || (not ??) so a 0 winsize falls back
    const cols = stdout.columns || 80;
    const streaming = model.streaming
      ? { text: model.streaming.text, thinking: model.streaming.thinking !== null }
      : undefined;
    let dialog: DialogFrame | undefined;
    const d = state.dialog;
    if (d) {
      switch (d.kind) {
        case "permission": {
          const req = d.req;
          const kind = req.toolCall.kind ?? "other";
          const tcTitle = req.toolCall.title ?? req.toolCall.toolCallId ?? "操作";
          dialog = {
            kind: "permission",
            toolTitle: tcTitle,
            borderDanger: kind === "edit" || kind === "delete" || tcTitle.includes("bash"),
            options: req.options.map((o) => ({
              id: o.optionId,
              name: o.name,
              danger: o.kind.startsWith("reject"),
            })),
            selected: d.selected,
          };
          break;
        }
        case "model-picker":
          dialog = {
            kind: "model-picker",
            models: state.availableModels.map((m) => ({
              modelId: m.modelId,
              name: m.name,
              current: m.modelId === state.currentModelId,
            })),
            selected: d.selected,
          };
          break;
        case "confirm-full-access":
          dialog = { kind: "confirm-full-access" };
          break;
      }
    }
    const inputText = input.text;
    const before = inputText.slice(0, input.cursorTextIndex);
    const frame: Frame = {
      appName: APP_NAME,
      modelLabel: state.currentModelId + (state.pendingModelSwitch ? "*" : ""),
      cwd: state.cwd,
      modeId: state.modeId,
      rows,
      cols,
      scroll: state.scroll,
      chat: model.entries,
      streaming,
      dialog,
      inputText,
      inputCursorText: input.cursorTextIndex,
      inputCursorCol: 2 + displayWidth(before),
      // IME anchor: the real caret must sit at the input cursor so composing
      // text (and the candidate window) land in the input row, never in the
      // chat area. While a modal dialog owns the keys there is nothing to
      // compose into, so the caret stays hidden.
      inputCaret: state.dialog === null,
      // Idle-only hint (busy shows the cancel hint instead): "press Ctrl+C
      // again to exit".
      inputHint: quitHint ?? undefined,
      busy: state.busy,
      canSend: !state.busy && !state.dialog,
      spinnerTick: Date.now(),
    };
    renderFrame(frame, theme, stdout);
  }

  const displayWidth = (s: string): number => stringWidth(s);

  // ── 6. ACP bridge events ──
  const bridge = new TuiBridge(config, {
    onSessionUpdate: (n: SessionNotification) => {
      // Drop late notifications from retired sessions (/new replaced ours).
      if (n.sessionId !== state.sessionId) return;
      if (model.applyUpdate(n)) render();
    },
    onPermissionRequest: (req: RequestPermissionRequest) => {
      if (req.sessionId !== state.sessionId) {
        // Stale request from a previous session — refuse it immediately.
        bridge.dismissPermission();
        return;
      }
      state.dialog = { kind: "permission", req, selected: 0 };
      render();
    },
  });

  // ── 7. handshake + first session ──
  try {
    const init = await bridge.initialize();
    void init;
    const session = await bridge.newSession(state.cwd);
    state.sessionId = session.sessionId;
    state.modeId = (session.modes?.currentModeId as "confirm" | "auto") ?? "confirm";
    state.currentModelId = session.models?.currentModelId ?? config.provider.model;
    state.availableModels = session.models?.availableModels ?? [
      { modelId: config.provider.model, name: config.provider.model },
    ];
    model.addNotice(`已连接到本地 agent（${config.provider.type} / ${state.currentModelId}）。输入 /help 查看命令。`);
  } catch (e) {
    restoreTerminal();
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`初始化失败：${msg}\n`);
    return 1;
  }

  // ── 8. lifecycle / crash recovery ──
  const fatal = (e: unknown): void => {
    restoreTerminal();
    process.stderr.write(
      `\nsangxia tui 致命错误：${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    );
    process.exit(1);
  };
  process.on("uncaughtException", fatal);
  // Rejected promises are handled at their source (see fireAndLog / submit's
  // try-catch); anything that still slips through must NOT kill the UI — log
  // it and surface a red row instead.
  const onUnhandledRejection = (reason: unknown): void => {
    logger.error("未处理的 Promise 拒绝（已降级为提示）:", reason);
    if (!state.quitting) {
      model.addNotice(`内部错误：${reason instanceof Error ? reason.message : String(reason)}`, true);
      render();
    }
  };
  process.on("unhandledRejection", onUnhandledRejection);
  const onSignal = (sig: NodeJS.Signals): void => {
    restoreTerminal();
    logger.info(`signal ${sig}, exiting`);
    process.exit(sig === "SIGTERM" ? 143 : 129);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  // Resize: the terminal has reflowed, so the dirty-row diff cache is stale —
  // clear it and force a full repaint (design review P0-2).
  const onResize = (): void => {
    invalidateFrame(stdout);
    render();
  };
  stdout.on("resize", onResize);

  // ── 9. keys ──
  const keys = new KeyReader((k) => handleKey(k));
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk: Buffer) => keys.push(chunk));

  // Periodic repaint for spinner while busy.
  const animTimer = setInterval(() => {
    if (state.busy && !state.quitting) render();
  }, 200);

  // ── command execution ──
  async function runCommand(action: CommandAction): Promise<void> {
    switch (action.kind) {
      case "quit":
        await quit();
        return;
      case "help":
        model.addHelp();
        render();
        return;
      case "clear":
        model.clearScreen();
        render();
        return;
      case "new-session": {
        if (state.busy) {
          model.addNotice("上一轮仍在进行，请先等待或 Ctrl+C 取消", true);
        } else {
          try {
            const session = await bridge.newSession(state.cwd);
            state.sessionId = session.sessionId;
            state.modeId = (session.modes?.currentModeId as "confirm" | "auto") ?? "confirm";
            state.currentModelId = session.models?.currentModelId ?? config.provider.model;
            state.availableModels = session.models?.availableModels ?? state.availableModels;
            state.pendingModelSwitch = null;
            model.resetForNewSession();
            model.addNotice("已开始新会话（旧会话已持久化到 ~/.config/sangxia/sessions/）");
          } catch (e) {
            model.addNotice(`开新会话失败：${e instanceof Error ? e.message : String(e)}`, true);
          }
        }
        render();
        return;
      }
      case "show-access-status":
        model.addNotice(
          `当前权限模式：${modeLabel()}（/access full 切换为 FULL ACCESS，需二次确认）`,
          state.modeId === "auto",
        );
        render();
        return;
      case "request-full-access":
        state.dialog = { kind: "confirm-full-access" };
        render();
        return;
      case "set-mode": {
        try {
          // M3: always really send set_mode, even when already in that mode —
          // the agent clears its permission memory on every setSessionMode
          // (N1), which is the recovery path for an "always reject" choice.
          await bridge.setMode(state.sessionId!, action.modeId);
          state.modeId = action.modeId;
          model.addNotice(
            action.modeId === "auto"
              ? "已切换为 FULL ACCESS：变更操作将不再请求确认"
              : "已切换为 Standard Access：变更操作每次请求确认",
            action.modeId === "auto",
          );
        } catch (e) {
          model.addNotice(`切换失败：${e instanceof Error ? e.message : String(e)}`, true);
        }
        render();
        return;
      }
      case "permissions-reset": {
        // Syntax sugar: re-send set_mode with the current mode so the agent
        // clears its "always allow/reject" memory (N1) — zero new API.
        try {
          await bridge.setMode(state.sessionId!, state.modeId);
          model.addNotice("已清空“总是允许/总是拒绝”的记住决策");
        } catch (e) {
          model.addNotice(`重置失败：${e instanceof Error ? e.message : String(e)}`, true);
        }
        render();
        return;
      }
      case "show-model-picker": {
        if (state.availableModels.length <= 1) {
          model.addNotice("配置里只有一个模型（见 provider.models），无需切换");
          render();
          return;
        }
        state.dialog = { kind: "model-picker", selected: 0 };
        render();
        return;
      }
      case "set-model": {
        const target = state.availableModels.find((m) => m.modelId === action.modelId);
        if (!target) {
          model.addNotice(
            `未知模型：${action.modelId}（可用：${state.availableModels.map((m) => m.modelId).join("、")}）`,
            true,
          );
          render();
          return;
        }
        try {
          await bridge.setModel(state.sessionId!, target.modelId);
          if (state.busy) {
            // B5 (turn in progress): the running turn already picked its
            // provider, so the switch applies next turn. Keep the old id in
            // the status bar with the pending "*" marker until that turn ends.
            state.pendingModelSwitch = target.modelId;
            model.addNotice(`model -> ${target.modelId}（下一轮生效）`);
          } else {
            // Idle: no turn is using the old provider, so reflect the switch
            // immediately — no star, no stale "old model running" ambiguity.
            state.currentModelId = target.modelId;
            state.pendingModelSwitch = null;
            model.addNotice(`model -> ${target.modelId}`);
          }
        } catch (e) {
          model.addNotice(`切换失败：${e instanceof Error ? e.message : String(e)}`, true);
        }
        render();
        return;
      }
      case "unknown-command":
        model.addNotice(`未知命令：/${action.name}（/help 查看可用命令）`, true);
        render();
        return;
      case "command-error":
        model.addNotice(action.message, true);
        render();
        return;
    }
  }

  // ── turn submission ──
  async function submit(line: string): Promise<void> {
    if (line.trim() === "") return;
    const parsed = parseCommand(line, { modelIds: state.availableModels.map((m) => m.modelId) });
    if (parsed.isCommand && parsed.action) {
      input.commit();
      await runCommand(parsed.action);
      return;
    }

    input.commit();
    model.addUser(line);
    render();

    state.busy = true;
    render();
    try {
      const res = await bridge.prompt(state.sessionId!, line);
      if (state.pendingModelSwitch) {
        // The turn that just ended ran on the old model; now the pending
        // switch becomes effective.
        state.currentModelId = state.pendingModelSwitch;
        state.pendingModelSwitch = null;
      }
      switch (res.stopReason) {
        case "end_turn":
          model.finalizeStream();
          break;
        case "cancelled":
          model.finalizeStream();
          model.addNotice("已取消", true);
          break;
        case "refusal":
          model.finalizeStream();
          model.addNotice("模型拒绝或调用失败", true);
          break;
        case "max_turn_requests":
          model.finalizeStream();
          model.addMeta("已达最大迭代次数（maxIterations），回答可能未完成");
          break;
        case "max_tokens":
          model.finalizeStream();
          model.addMeta("输出被 max_tokens 截断");
          break;
      }
    } catch (e) {
      model.finalizeStream();
      model.addNotice(`调用失败：${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      state.busy = false;
      state.scroll = 0;
      render();
    }
  }

  function cancelTurn(): void {
    if (!state.sessionId) return;
    fireAndLog(bridge.cancel(state.sessionId), "取消");
    // ACP: after cancel the client must settle pending permission requests,
    // otherwise the agent's ensurePermission waits forever (design §7 A7).
    bridge.cancelPendingPermission();
  }

  /**
   * Fire-and-forget a promise, surfacing any rejection as a red notice instead
   * of letting it hit the (degraded, non-fatal) unhandledRejection path.
   */
  function fireAndLog(p: Promise<unknown>, what: string): void {
    p.catch((e) => {
      logger.error(`异步操作失败（${what}）:`, e);
      if (!state.quitting) {
        model.addNotice(`操作失败：${e instanceof Error ? e.message : String(e)}`, true);
        render();
      }
    });
  }

  function pickRejectOnce(options: PermissionOption[]): string | null {
    return options.find((o) => o.kind === "reject_once")?.optionId ?? null;
  }

  // ── key dispatch ──
  function handleKey(k: Key): void {
    if (state.quitting) return;
    if (state.dialog) {
      dialogKey(k);
      return;
    }
    // Any other key means the user is still working: cancel a pending
    // "press Ctrl+C again" arm (and drop its hint). Most branches below
    // repaint, so the hint disappears with them.
    if (k.type !== "ctrl-c") disarmQuit();
    switch (k.type) {
      case "char":
        input.insert(k.char);
        render();
        break;
      case "paste": {
        // Single-line editor: normalize pasted newlines (incl. CRLF) to
        // spaces so multi-line paste becomes one editable line and never
        // triggers Enter.
        const text = k.text.replace(/\r\n|\r|\n/g, " ");
        if (text !== "") {
          input.insert(text);
          render();
        }
        break;
      }
      case "enter":
        if (state.busy) {
          // Concurrency guard (§7): never fire a second prompt mid-turn.
          model.addMeta("上一轮仍在进行，Ctrl+C 可取消");
          render();
        } else if (!input.isEmpty()) {
          const line = input.text;
          fireAndLog(submit(line), "发送");
        }
        break;
      case "ctrl-c":
        if (state.busy) {
          model.addMeta("取消中…");
          cancelTurn();
        } else if (!input.isEmpty()) {
          // Same key clears the line first, then (a second press) exits.
          input.clear();
          armQuit("输入已清空；再按一次 Ctrl+C 退出");
        } else if (quitGate.armed) {
          fireAndLog(quit(), "退出");
          return; // quit() tears the UI down; nothing left to repaint
        } else {
          armQuit("再按一次 Ctrl+C 退出（Ctrl+D 也可退出）");
        }
        render();
        break;
      case "ctrl-d":
        if (!state.busy && input.isEmpty()) {
          fireAndLog(quit(), "退出");
        } else {
          input.deleteForward();
        }
        render();
        break;
      case "ctrl-u":
        input.deleteToStart();
        render();
        break;
      case "ctrl-w":
        input.deleteWordBack();
        render();
        break;
      case "ctrl-l":
        render();
        break;
      case "ctrl-a":
      case "home":
        input.moveToStart();
        render();
        break;
      case "ctrl-e":
      case "end":
        input.moveToEnd();
        render();
        break;
      case "left":
        input.moveLeft();
        render();
        break;
      case "right":
        input.moveRight();
        render();
        break;
      case "up":
        if (!state.busy) {
          input.historyUp();
          render();
        }
        break;
      case "down":
        input.historyDown();
        render();
        break;
      case "backspace":
        input.backspace();
        render();
        break;
      case "delete":
        input.deleteForward();
        render();
        break;
      case "tab": {
        const candidates = completeLine(input.text, {
          modelIds: state.availableModels.map((m) => m.modelId),
        });
        if (candidates.length === 1) {
          input.setText(candidates[0]!);
          render();
        } else if (candidates.length > 1) {
          input.setText(commonPrefix(candidates));
          render();
        }
        break;
      }
      case "pgup":
        state.scroll += 5;
        render();
        break;
      case "pgdn":
        state.scroll = Math.max(0, state.scroll - 5);
        render();
        break;
      case "shift-up":
        state.scroll += 1;
        render();
        break;
      case "shift-down":
        state.scroll = Math.max(0, state.scroll - 1);
        render();
        break;
      default:
        break;
    }
  }

  function dialogKey(k: Key): void {
    const d = state.dialog;
    if (!d) return;
    switch (d.kind) {
      case "permission": {
        const req = d.req;
        const n = req.options.length;
        if (k.type === "up") {
          d.selected = (d.selected - 1 + n) % n;
          render();
        } else if (k.type === "down") {
          d.selected = (d.selected + 1) % n;
          render();
        } else if (k.type === "enter") {
          const opt = req.options[d.selected];
          state.dialog = null;
          if (opt) bridge.respondPermission(opt.optionId);
          else bridge.dismissPermission();
          render();
        } else if (k.type === "char" && /^[1-9]$/.test(k.char)) {
          const idx = Number(k.char) - 1;
          if (idx < n) {
            const opt = req.options[idx];
            state.dialog = null;
            if (opt) bridge.respondPermission(opt.optionId);
            render();
          }
        } else if (k.type === "escape") {
          // N4: prefer a reject_once option over a bare cancel (semantics of
          // cancelled = "cancel the whole turn").
          state.dialog = null;
          const reject = pickRejectOnce(req.options);
          if (reject) bridge.respondPermission(reject);
          else bridge.dismissPermission();
          render();
        } else if (k.type === "ctrl-c") {
          state.dialog = null;
          bridge.dismissPermission();
          if (state.busy) cancelTurn();
          render();
        }
        break;
      }
      case "model-picker": {
        const models = state.availableModels;
        if (k.type === "up") {
          d.selected = (d.selected - 1 + models.length) % models.length;
          render();
        } else if (k.type === "down") {
          d.selected = (d.selected + 1) % models.length;
          render();
        } else if (k.type === "enter") {
          const target = models[d.selected];
          state.dialog = null;
          render();
          if (target && target.modelId !== state.currentModelId) {
            awaitCmd({ kind: "set-model", modelId: target.modelId });
          }
        } else if (k.type === "escape" || k.type === "ctrl-c") {
          state.dialog = null;
          render();
        }
        break;
      }
      case "confirm-full-access": {
        if (k.type === "char" && (k.char === "y" || k.char === "Y")) {
          state.dialog = null;
          render();
          awaitCmd({ kind: "set-mode", modeId: "auto" });
        } else if (k.type === "escape" || k.type === "ctrl-c" || k.type === "enter" || (k.type === "char" && (k.char === "n" || k.char === "N"))) {
          state.dialog = null;
          render();
        }
        break;
      }
    }
  }

  /** Fire a command from a key handler without awaiting (keeps the loop live). */
  function awaitCmd(action: CommandAction): void {
    fireAndLog(runCommand(action), "命令");
  }

  function commonPrefix(candidates: string[]): string {
    if (candidates.length === 0) return "";
    let prefix = candidates[0]!;
    for (let i = 1; i < candidates.length; i++) {
      const c = candidates[i]!;
      let j = 0;
      while (j < prefix.length && j < c.length && prefix[j] === c[j]) j += 1;
      prefix = prefix.slice(0, j);
    }
    return prefix;
  }

  // ── quit ──
  async function quit(): Promise<void> {
    if (state.quitting) return;
    state.quitting = true;
    try {
      if (state.busy && state.sessionId) {
        bridge.cancelPendingPermission();
        await bridge.cancel(state.sessionId).catch(() => {});
      }
      await bridge.shutdown();
    } catch {
      /* best effort */
    }
    clearInterval(animTimer);
    process.stdin.removeAllListeners("data");
    process.stdin.pause();
    process.stdin.setRawMode(false);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGHUP", onSignal);
    process.removeListener("uncaughtException", fatal);
    process.removeListener("unhandledRejection", onUnhandledRejection);
    stdout.removeListener("resize", onResize);
    restoreTerminal();
    logger.info("sangxia tui exit");
    process.exit(0);
  }

  // ── first paint + idle notice ──
  paintFrame();
  return new Promise<number>(() => {
    // runTui keeps the process alive via stdin; quit() calls process.exit.
    // This never resolves — kept as a Promise for API symmetry.
  });
}

