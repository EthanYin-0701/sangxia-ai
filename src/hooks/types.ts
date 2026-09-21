/**
 * Hook（生命周期钩子）类型定义。
 *
 * 设计见 `plan/hooks_support.md`：hook 是**本地配置驱动**的外部进程，在 harness 的
 * 固定点位被自动触发 —— 通过 stdin 收一个 JSON 信封，用 stdout 决策 JSON + 退出码
 * 给出决策（`exit 2` 等价 deny）。它不是工具（模型看不见），也不是权限的替代
 * （`allow` 不跳过 `session/request_permission`）。
 */

/** v1 的六个事件，顺序与文档 §3 一致。 */
export const HOOK_EVENTS = [
  "session_start",
  "user_prompt_submit",
  "pre_tool_use",
  "post_tool_use",
  "turn_end",
  "session_end",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** 单条 hook 配置（配置级已解析路径；项目级在会话建立时解析）。 */
export interface HookEntry {
  /** 日志标识，缺省用 command。 */
  name?: string;
  /** 经 shell 执行。路径形态的命令已在加载期解析成绝对路径（D15）。 */
  command: string;
  /**
   * 仅 `pre_tool_use` / `post_tool_use` 生效：JS 正则，作用于**工具注册名**。
   * MCP 工具必须带前缀，如 `^mcp__router__execute_terminal_command$`。
   */
  matcher?: string;
  /** 覆盖全局 `hooks.timeoutMs`。 */
  timeoutMs?: number;
  /** 覆盖全局 `hooks.onError`：失败（超时/崩溃/输出不可解析）时 allow 还是 deny。 */
  onError?: "allow" | "deny";
}

/** 传给 hook 进程的 stdin 信封：公共字段 + 各事件附加字段。 */
export interface HookPayload {
  hook_event_name: HookEvent;
  session_id: string;
  /** session 工作目录。注意：它与"命令路径的解析基准"是两件事（D15）。 */
  cwd: string;
  permission_mode: string;
  model_id: string;
  /** 配置里的 `name`（可空）。 */
  hook_name?: string;
  timestamp: string;
  [key: string]: unknown;
}

/** stdout 决策 JSON（顶层 `decision`，或 Claude Code 风格的 `hookSpecificOutput`）。 */
export interface HookOutput {
  decision?: string;
  reason?: string;
  hookSpecificOutput?: {
    /** Claude Code 新式写法；与顶层 `decision` 二选一（顶层优先）。 */
    permissionDecision?: string;
    /** 仅 pre_tool_use：**整体替换**工具参数（不是补丁）。 */
    updatedInput?: Record<string, unknown>;
    /** 仅 user_prompt_submit：改写提交给模型的 prompt。 */
    updatedPrompt?: string;
    /** session_start / post_tool_use：追加进上下文/工具结果的文本。 */
    additionalContext?: string;
  };
}

/** 一次事件的汇总决策（多条 hook 串行后的结果）。 */
export interface HookOutcome {
  /** deny > ask > allow。 */
  decision: "allow" | "deny" | "ask";
  /** 做出 deny/ask 的 hook 名（日志与文案用）。 */
  hookName?: string;
  /** deny/ask 的原因（原始文本，调用方自己加前缀）。 */
  reason?: string;
  /** pre_tool_use：链式改写后的最终参数（已由各条 hook 依序整体替换）。 */
  updatedInput?: Record<string, unknown>;
  /** user_prompt_submit：改写后的 prompt。 */
  updatedPrompt?: string;
  /** 按事件落点拼接的注入文本，元素形如 `[hook <name>]\n<content>`。 */
  additionalContext: string[];
  /** 实际执行的 hook 数（诊断/日志）。 */
  ran: number;
  elapsedMs: number;
  /** 失败 hook 的简述（超时/崩溃/输出不可解析/未知 decision 值）。 */
  errors: string[];
}

export function emptyOutcome(): HookOutcome {
  return { decision: "allow", additionalContext: [], ran: 0, elapsedMs: 0, errors: [] };
}
