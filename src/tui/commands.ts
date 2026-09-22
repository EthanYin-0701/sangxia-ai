/**
 * Slash-command parsing & help (commands.ts).
 *
 * Pure functions — no I/O. The controller turns a parsed action into bridge /
 * UI calls. Commands are purely client-side (§4 of plan/tui_support.md): they
 * deliberately do NOT go through ACP `available_commands_update`; Zed has its
 * own native model/mode pickers, so `/model` & `/access` exist only here.
 */

export interface CommandContext {
  modelIds: string[];
}

export type CommandAction =
  | { kind: "quit" }
  | { kind: "help" }
  | { kind: "clear" }
  | { kind: "new-session" }
  | { kind: "show-model-picker" }
  | { kind: "set-model"; modelId: string }
  | { kind: "show-access-status" }
  | { kind: "request-full-access" }
  | { kind: "set-mode"; modeId: "confirm" | "auto" }
  | { kind: "permissions-reset" }
  | { kind: "unknown-command"; name: string }
  | { kind: "command-error"; message: string };

const COMMAND_NAMES = ["help", "model", "access", "clear", "new", "quit", "permissions"];
/** 用户原话写作过 /acess —— 低成本别名，顺手兼容。 */
const ALIASES: Record<string, string> = { acess: "access" };

export interface ParseResult {
  isCommand: boolean;
  action?: CommandAction;
  /** Display name of the parsed command (after alias resolution). */
  name?: string;
}

/**
 * Decide whether a submitted input line is a slash command and what it means.
 * `//...` starts with a slash but is ordinary text (so users can type URLs).
 */
export function parseCommand(line: string, _ctx: CommandContext): ParseResult {
  if (!line.startsWith("/") || line.startsWith("//")) return { isCommand: false };
  const trimmed = line.trim();
  if (trimmed === "/") return { isCommand: true, name: "", action: { kind: "command-error", message: "空的斜杠命令（/help 查看可用命令）" } };

  const [rawName, ...rest] = trimmed.slice(1).split(/\s+/);
  const name = ALIASES[rawName ?? ""] ?? rawName ?? "";
  const arg = rest.join(" ").trim();

  const error = (message: string): ParseResult => ({ isCommand: true, name, action: { kind: "command-error", message } });
  const unknown = (): ParseResult => ({ isCommand: true, name, action: { kind: "unknown-command", name } });

  switch (name) {
    case "quit":
      return { isCommand: true, name, action: { kind: "quit" } };
    case "help":
      return { isCommand: true, name, action: { kind: "help" } };
    case "clear":
      return { isCommand: true, name, action: { kind: "clear" } };
    case "new":
      return { isCommand: true, name, action: { kind: "new-session" } };
    case "permissions":
      if (arg === "reset") return { isCommand: true, name, action: { kind: "permissions-reset" } };
      return error("/permissions reset —— 清空本会话“总是允许/总是拒绝”的记住决策");
    case "model":
      if (!arg) return { isCommand: true, name, action: { kind: "show-model-picker" } };
      return { isCommand: true, name, action: { kind: "set-model", modelId: arg } };
    case "access": {
      if (!arg) return { isCommand: true, name, action: { kind: "show-access-status" } };
      if (arg === "full" || arg === "auto") return { isCommand: true, name, action: { kind: "request-full-access" } };
      if (arg === "standard" || arg === "confirm") return { isCommand: true, name, action: { kind: "set-mode", modeId: "confirm" } };
      return error("/access [full|standard] —— full 进入完全访问（需确认），standard 切回标准访问");
    }
    default:
      return unknown();
  }
}

export interface HelpLine {
  kind: "heading" | "cmd" | "danger" | "text";
  text: string;
}

export function helpLines(): HelpLine[] {
  return [
    { kind: "heading", text: "斜杠命令" },
    { kind: "cmd", text: "/model [modelId]   查看/切换模型（无参数弹出选择器；模型下一轮生效）" },
    { kind: "danger", text: "/access [full|standard]   权限模式：full=完全访问(自动批准，危险)，standard=标准访问(每次确认)" },
    { kind: "text", text: "/access        只显示当前权限模式" },
    { kind: "cmd", text: "/permissions reset   清空本会话“总是允许/总是拒绝”的记住决策" },
    { kind: "text", text: "/clear         清空屏幕（不影响会话历史）" },
    { kind: "text", text: "/new           重开会话（仅空闲时；旧会话已持久化）" },
    { kind: "text", text: "/help          显示本帮助" },
    { kind: "text", text: "/quit          退出（或空闲时连按两次 Ctrl+C / 空行 Ctrl+D）" },
    { kind: "text", text: "" },
    { kind: "text", text: "快捷键：Enter 发送 · ↑/↓ 历史 · Tab 补全 · Ctrl+C 清空输入（空闲时连按两次=退出，turn 中=取消）· Ctrl+U 删到行首 · Ctrl+D 删字符(空行退出)" },
    { kind: "text", text: "以 // 开头的输入按普通文本发送。" },
  ];
}

/**
 * Tab-completion candidates for the current input line. Returns full candidate
 * strings (only the matching suffix is inserted by the caller).
 */
export function completeLine(line: string, ctx: CommandContext): string[] {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("/")) return [];
  const lower = trimmed.toLowerCase();
  const spaceIdx = lower.indexOf(" ");
  if (spaceIdx === -1) {
    // Completing the command name itself.
    const prefix = lower.slice(1);
    return COMMAND_NAMES.filter((n) => n.startsWith(prefix)).map((n) => `/${n}`);
  }
  const cmd = lower.slice(1, spaceIdx);
  const argPrefix = trimmed.slice(spaceIdx + 1);
  switch (cmd) {
    case "model":
    case "model ": {
      return ctx.modelIds.filter((id) => id.startsWith(argPrefix)).map((id) => `/model ${id}`);
    }
    case "access": {
      const modes = ["full", "standard", "confirm", "auto"];
      return modes.filter((m) => m.startsWith(argPrefix)).map((m) => `/access ${m}`);
    }
    default:
      return [];
  }
}
