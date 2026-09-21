import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { interpolateEnv, type HooksConfig } from "../config.js";
import { logger } from "../logger.js";
import { runHookProcess } from "./exec.js";
import { assertValidHookEntries, resolveHookCommands } from "./paths.js";
import { emptyOutcome, HOOK_EVENTS, type HookEntry, type HookEvent, type HookOutcome, type HookPayload } from "./types.js";
import { truncateMiddle } from "../harness/truncate.js";

/**
 * HookRegistry —— 从配置（+ 可选项目级文件）构建，在 harness 的点位上执行 hook。
 *
 * 对外只暴露 `has()`（零开销跳过）与 `run()`（汇总决策）。所有异常都被吞掉：
 * hook 失败绝不能影响 turn 收敛，最坏是"少一次拦截 + 一条 warn 日志"。
 */

/** 单条 hook 注入文本的上限（review L1：不要被工具输出挤掉）。 */
const CONTEXT_LIMIT = 20_000;
/** 一次事件注入文本的合计上限。 */
const CONTEXT_TOTAL_LIMIT = 40_000;

export interface HookSessionInfo {
  id: string;
  cwd: string;
  permissionMode: string;
  modelId: string;
}

/** 构建传给 hook 进程的 stdin 信封（公共字段 + 事件附加字段）。 */
export function hookPayload(
  session: HookSessionInfo,
  event: HookEvent,
  extra: Record<string, unknown> = {},
): HookPayload {
  return {
    hook_event_name: event,
    session_id: session.id,
    cwd: session.cwd,
    permission_mode: session.permissionMode,
    model_id: session.modelId,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

/** 环境变量通道（除 stdin JSON 外的第二条通道，便于 shell 脚本简单取值）。 */
export function hookEnv(payload: HookPayload): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ZHENTE_HOOK_EVENT: payload.hook_event_name,
    ZHENTE_SESSION_ID: payload.session_id,
    ZHENTE_CWD: payload.cwd,
    ZHENTE_PERMISSION_MODE: payload.permission_mode,
    // L5：与 Claude Code 的 CLAUDE_PROJECT_DIR 语义对齐 = 项目根（session cwd），
    // 不是 ZhenTe 进程的启动目录；后者单独给一个不会误导的名字。
    ZHENTE_PROJECT_DIR: payload.cwd,
    ZHENTE_AGENT_CWD: process.cwd(),
  };
}

interface CompiledEntry {
  entry: HookEntry;
  matcher?: RegExp;
}

export class HookRegistry {
  /** 无 hook 时的空实现（`has()` 恒 false，零开销）。 */
  static readonly empty = new HookRegistry(
    {
      enabled: false,
      timeoutMs: 60_000,
      onError: "allow",
      shell: null,
      projectFile: { enabled: false, path: ".zhente/hooks.json" },
      events: Object.fromEntries(HOOK_EVENTS.map((e) => [e, []])) as unknown as HooksConfig["events"],
    },
    {},
  );

  readonly #config: HooksConfig;
  readonly #entries: Record<HookEvent, CompiledEntry[]>;

  constructor(config: HooksConfig, projectEntries: Partial<Record<HookEvent, HookEntry[]>>) {
    this.#config = config;
    this.#entries = Object.fromEntries(
      HOOK_EVENTS.map((event) => [
        event,
        // 配置级先跑、项目级后跑（§4-5）；项目级条目已在加载时钳制（L3）。
        [...config.events[event], ...(projectEntries[event] ?? [])].map((entry) => ({
          entry,
          matcher: entry.matcher !== undefined ? new RegExp(entry.matcher) : undefined,
        })),
      ]),
    ) as Record<HookEvent, CompiledEntry[]>;

    // 非工具事件上的 matcher 是配置笔误：忽略它（见 run()），但提示一次，
    // 否则一条写错位置的 matcher 会让 hook 静默不执行。
    for (const event of HOOK_EVENTS) {
      if (event === "pre_tool_use" || event === "post_tool_use") continue;
      for (const { entry } of this.#entries[event]) {
        if (entry.matcher !== undefined) {
          logger.warn(
            `hook ${event} "${entry.name ?? entry.command}" 配置了 matcher，但该事件不是工具事件 —— matcher 被忽略`,
          );
        }
      }
    }
  }

  /** 该事件是否有任何 hook；false 时调用方直接跳过，零开销。 */
  has(event: HookEvent): boolean {
    return this.#config.enabled && this.#entries[event].length > 0;
  }

  /** 按事件 + matcher 选取并**串行**执行 hook，汇总成一个决策。 */
  async run(
    event: HookEvent,
    payload: HookPayload,
    opts: { signal?: AbortSignal } = {},
  ): Promise<HookOutcome> {
    const outcome = emptyOutcome();
    if (!this.has(event)) return outcome;
    const startedAt = Date.now();
    // `matcher` 只对工具事件有意义；其它事件上配了也忽略（构造时已 warn 一次），
    // 否则一条写错位置的 matcher 会让 hook 静默不执行。
    const isToolEvent = event === "pre_tool_use" || event === "post_tool_use";
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
    const selected = this.#entries[event].filter(
      ({ matcher }) => !isToolEvent || !matcher || matcher.test(toolName),
    );
    let effectiveInput =
      event === "pre_tool_use" && payload.tool_input && typeof payload.tool_input === "object"
        ? (payload.tool_input as Record<string, unknown>)
        : undefined;

    for (const { entry } of selected) {
      if (opts.signal?.aborted) break;
      const label = entry.name ?? entry.command;
      const onError = entry.onError ?? this.#config.onError;
      const result = await runHookProcess(
        entry,
        // pre_tool_use 的 tool_input 是链式的：后一条 hook 看到前一条改写的结果（D11）。
        { ...payload, hook_name: label, ...(effectiveInput ? { tool_input: effectiveInput } : {}) },
        {
          cwd: payload.cwd,
          shell: this.#config.shell,
          timeoutMs: entry.timeoutMs ?? this.#config.timeoutMs,
          onError,
          env: hookEnv(payload),
          signal: opts.signal,
        },
      );
      if (result.cancelled) break;
      outcome.ran++;

      if (result.failed) {
        outcome.errors.push(`${label}: ${result.error}`);
        logger.warn(
          `hook ${event} "${label}" 执行失败: ${result.error}（onError=${onError}）` +
            (result.stderr.trim() ? ` stderr=${JSON.stringify(result.stderr.trim().slice(-500))}` : ""),
        );
        if (result.decision === "deny") {
          outcome.decision = "deny";
          outcome.hookName = label;
          outcome.reason = result.reason ?? result.error;
          break;
        }
        continue;
      }

      logger.info(
        `hook ${event} "${label}" exit=${result.exitCode ?? "null"} decision=${result.decision} ` +
          `elapsedMs=${result.elapsedMs}`,
      );
      if (result.decision === "deny") {
        outcome.decision = "deny";
        outcome.hookName = label;
        outcome.reason = result.reason;
        break;
      }
      if (result.decision === "ask" && outcome.decision === "allow") {
        outcome.decision = "ask";
        outcome.hookName = label;
        outcome.reason = result.reason;
      }

      const specific = result.output?.hookSpecificOutput;
      if (
        event === "pre_tool_use" &&
        specific?.updatedInput &&
        typeof specific.updatedInput === "object" &&
        !Array.isArray(specific.updatedInput)
      ) {
        effectiveInput = specific.updatedInput;
        outcome.updatedInput = effectiveInput;
      }
      if (event === "user_prompt_submit" && typeof specific?.updatedPrompt === "string") {
        outcome.updatedPrompt = specific.updatedPrompt;
      }
      if (typeof specific?.additionalContext === "string" && specific.additionalContext.trim()) {
        outcome.additionalContext.push(
          `[hook ${label}]\n${truncateMiddle(specific.additionalContext.trim(), CONTEXT_LIMIT)}`,
        );
      }
      if (result.stderr.trim()) {
        logger.debug(`hook ${event} "${label}" stderr: ${result.stderr.trim().slice(-2000)}`);
      }
    }

    if (outcome.additionalContext.length > 0) {
      const joined = outcome.additionalContext.join("\n\n");
      if (joined.length > CONTEXT_TOTAL_LIMIT) {
        outcome.additionalContext = [truncateMiddle(joined, CONTEXT_TOTAL_LIMIT)];
      }
    }
    outcome.elapsedMs = Date.now() - startedAt;
    return outcome;
  }
}

/**
 * 构建一个会话的 hook 注册表：配置级（已在 `loadConfig` 解析路径）+ 可选项目级文件。
 *
 * 项目级 hooks（`.zhente/hooks.json`）默认关闭（D4：随仓库分发 = 打开仓库就执行任意
 * 命令，供应链风险）；显式 `projectFile.enabled: true` 才加载，此时该文件损坏/脚本缺失
 * 一律**直接报错**（显式开启即视为信任该仓库，坏掉的守卫不能静默失效）。
 */
export function createHookRegistry(config: HooksConfig, opts: { cwd: string }): HookRegistry {
  // `?.` is deliberate: scripts and embedders sometimes build a partial config
  // object; hooks are opt-in, so a missing section means "no hooks".
  if (!config?.enabled) return HookRegistry.empty;
  return new HookRegistry(config, loadProjectEntries(config, opts.cwd));
}

function loadProjectEntries(
  config: HooksConfig,
  cwd: string,
): Partial<Record<HookEvent, HookEntry[]>> {
  if (!config.projectFile.enabled) return {};
  const path = isAbsolute(config.projectFile.path)
    ? config.projectFile.path
    : resolve(cwd, config.projectFile.path);
  if (!existsSync(path)) {
    logger.warn(`hooks.projectFile.enabled=true 但项目级 hooks 文件不存在: ${path}`);
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`项目级 hooks 文件无法解析 (${path}): ${e instanceof Error ? e.message : String(e)}`);
  }
  const data = interpolateEnv(raw) as { events?: Record<string, unknown> };
  const out: Partial<Record<HookEvent, HookEntry[]>> = {};
  let count = 0;
  for (const event of HOOK_EVENTS) {
    const value = data?.events?.[event];
    if (value === undefined) continue;
    if (!Array.isArray(value)) throw new Error(`项目级 hooks 文件 ${path} 的 events.${event} 必须是数组`);
    const entries = value as HookEntry[];
    const where = `项目级 hooks 文件 ${path} events.${event}`;
    assertValidHookEntries(entries, where);
    const resolved = resolveHookCommands(entries, cwd, where).map((entry) => ({
      ...entry,
      // L3：项目级条目不能放宽限制 —— timeoutMs 取更小值，onError 只允许收紧到 deny。
      timeoutMs: Math.min(entry.timeoutMs ?? config.timeoutMs, config.timeoutMs),
      onError: (config.onError === "deny" || entry.onError === "deny" ? "deny" : "allow") as "allow" | "deny",
    }));
    out[event] = resolved;
    count += resolved.length;
  }
  if (count > 0) {
    logger.warn(
      `已启用项目级 hooks: ${path}（${count} 条，来自该仓库 —— 请确认你信任它）`,
    );
  }
  return out;
}
