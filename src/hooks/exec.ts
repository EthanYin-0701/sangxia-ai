import { spawn } from "node:child_process";
import type { HookEntry, HookOutput, HookPayload } from "./types.js";

/**
 * 单条 hook 的进程执行（plan §5 / §6.3 / §6.4）。
 *
 * 语义要点：
 * - `exit 0` + 空 stdout ⇒ **allow**（纯审计型 hook 的正常形态，不受 `onError` 影响）；
 * - `exit 2` ⇒ **deny**（无条件，优先于 `onError`），原因取 stdout.reason 或 stderr 末尾；
 * - 其它非 0 / 超时 / 信号 / stdout 非空但解析不出决策 ⇒ **失败**，按 `onError` 处理；
 * - signal（turn 的 AbortSignal）abort ⇒ 杀掉进程并按 allow 静默返回（用户已取消）；
 * - 超时先 SIGTERM 再 SIGKILL，**整棵进程组**（`shell: true` 下 child 是 /bin/sh，
 *   只杀 shell 会留下孙进程继续跑）。
 */

/** stdout / stderr 各自的累计上限（防止狂打印的 hook 撑爆内存）。 */
const MAX_STREAM_BYTES = 1024 * 1024;
/** `exit 2` 且 stdout 没给 reason 时，从 stderr 末尾取多少字符当原因。 */
const STDERR_REASON_CHARS = 500;
/** SIGTERM 之后给多少毫秒宽限再 SIGKILL。 */
const KILL_GRACE_MS = 2000;

export interface HookProcessResult {
  decision: "allow" | "deny" | "ask";
  output?: HookOutput;
  /** deny/ask/失败的原因文本（原始，不含前缀）。 */
  reason?: string;
  /** true = 超时 / 崩溃 / stdout 不可解析 / 未知 decision 值。 */
  failed: boolean;
  error?: string;
  /** 被 turn 取消而中止（不算失败，也不算失败日志）。 */
  cancelled: boolean;
  exitCode: number | null;
  elapsedMs: number;
  stderr: string;
}

export interface HookProcessOptions {
  /** hook 进程的工作目录（= session cwd，与命令路径解析基准无关）。 */
  cwd: string;
  /** null = 平台默认 shell。 */
  shell: string | null;
  timeoutMs: number;
  /** 已由调用方合并（entry.onError ?? config.onError）。 */
  onError: "allow" | "deny";
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** 顶层 decision 的取值映射：同时兼容 Claude Code 旧式 `approve` / `block`（M6）。 */
const DECISION_ALIASES: Record<string, "allow" | "deny" | "ask"> = {
  allow: "allow",
  approve: "allow",
  deny: "deny",
  block: "deny",
  ask: "ask",
};

function tryParseObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 从 `start` 处的 `{` 开始找匹配的 `}`（跳过字符串内的括号），找不到返回 -1。 */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

/** 从后往前找最后一个完整的 JSON 对象块（支持 pretty-print / jq 默认多行输出）。 */
function extractLastJsonObject(text: string): string | null {
  for (let start = text.lastIndexOf("{"); start >= 0; start = text.lastIndexOf("{", start - 1)) {
    const end = matchingBrace(text, start);
    if (end > start) return text.slice(start, end + 1);
  }
  return null;
}

/**
 * stdout 容错解析（§5.2 / D8，并处理 review L2 / M6）：
 * 整体 parse → 逐行取最后一个决策行 → 最后一个平衡大括号块。
 */
export function parseHookOutput(raw: string): { output?: HookOutput; error?: string } {
  const text = raw.trim();
  if (!text) return {};
  const direct = tryParseObject(text);
  if (direct) return { output: direct as HookOutput };
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = tryParseObject(lines[i]!.trim());
    if (obj && ("decision" in obj || "hookSpecificOutput" in obj)) return { output: obj as HookOutput };
  }
  const block = extractLastJsonObject(text);
  if (block) {
    const obj = tryParseObject(block);
    if (obj) return { output: obj as HookOutput };
  }
  return { error: `stdout 不是可解析的决策 JSON（${text.length} 字符）` };
}

/**
 * 读取决策值。字段缺失 = allow（`{}` 是合法输出）；字段存在但不是已知取值 =
 * **失败**，绝不能静默 allow（那会让一条拦截策略变成不拦截，见 review M6）。
 */
function readDecision(output: HookOutput): { decision?: "allow" | "deny" | "ask"; error?: string } {
  const raw = output.decision ?? output.hookSpecificOutput?.permissionDecision;
  if (raw === undefined) return {};
  if (typeof raw !== "string") return { error: "decision 字段不是字符串" };
  const mapped = DECISION_ALIASES[raw.trim().toLowerCase()];
  if (!mapped) return { error: `未知的 decision 取值 "${raw}"（可用: allow/approve/deny/block/ask）` };
  return { decision: mapped };
}

/** stderr 末尾 N 字符，作为 `exit 2` 的兜底原因。 */
function stderrTail(stderr: string): string {
  const text = stderr.trim();
  return text.length <= STDERR_REASON_CHARS ? text : text.slice(-STDERR_REASON_CHARS);
}

export function runHookProcess(
  entry: HookEntry,
  payload: HookPayload,
  opts: HookProcessOptions,
): Promise<HookProcessResult> {
  const startedAt = Date.now();
  const cancelledResult = (): HookProcessResult => ({
    decision: "allow",
    cancelled: true,
    failed: false,
    exitCode: null,
    elapsedMs: Date.now() - startedAt,
    stderr: "",
  });
  // 已经取消：连进程都不起（zero-cost path）。
  if (opts.signal?.aborted) return Promise.resolve(cancelledResult());

  return new Promise<HookProcessResult>((resolve) => {
    let settled = false;
    let cancelled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let outBytes = 0;
    let errBytes = 0;
    let killTimer: NodeJS.Timeout | undefined;
    /** 兜底定时器（unref 过）：管道不关时也能收尾。 */
    const extraTimers: (NodeJS.Timeout | undefined)[] = [];

    const child = spawn(entry.command, {
      shell: opts.shell ?? true,
      cwd: opts.cwd,
      env: opts.env,
      // 进程组：超时/取消时能杀掉 shell 及其所有子孙进程。
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const killTree = (sig: NodeJS.Signals) => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        if (process.platform === "win32") process.kill(pid, sig);
        else process.kill(-pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* 进程已退出 */
        }
      }
    };

    const onAbort = () => {
      cancelled = true;
      killTree("SIGKILL");
      // 兜底：万一有子孙进程脱离了进程组、管道迟迟不关（`close` 不触发），
      // 也必须让调用方拿到结论 —— hook 不允许卡住 turn。
      extraTimers.push(setTimeout(() => finish(cancelledResult()), KILL_GRACE_MS).unref?.());
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      // 宽限后强杀：hook 可能自己忽略 SIGTERM。
      killTimer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
      // 同上：`close` 不是硬保证，超时必须自己兜底收尾。
      extraTimers.push(
        setTimeout(() => finish(failure(`hook 超时（${opts.timeoutMs}ms）已终止`)), KILL_GRACE_MS + 1000).unref?.(),
      );
    }, opts.timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      for (const t of extraTimers) if (t !== undefined) clearTimeout(t);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (result: HookProcessResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const failure = (error: string): HookProcessResult => ({
      decision: opts.onError === "deny" ? "deny" : "allow",
      failed: true,
      error,
      ...(opts.onError === "deny" ? { reason: `hook 执行失败且 onError=deny：${error}` } : {}),
      cancelled: false,
      exitCode: child.exitCode,
      elapsedMs: Date.now() - startedAt,
      stderr,
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (outBytes >= MAX_STREAM_BYTES) return;
      outBytes += chunk.length;
      stdout += chunk.toString("utf8");
      if (outBytes > MAX_STREAM_BYTES) stdout = stdout.slice(0, MAX_STREAM_BYTES);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errBytes >= MAX_STREAM_BYTES) return;
      errBytes += chunk.length;
      stderr += chunk.toString("utf8");
      if (errBytes > MAX_STREAM_BYTES) stderr = stderr.slice(0, MAX_STREAM_BYTES);
    });

    // stdin：一次写完即关闭。hook 不读 stdin 时的 EPIPE 忽略，不算错误。
    child.stdin?.on("error", () => {});
    child.stdin?.end(`${JSON.stringify(payload)}\n`);

    child.on("error", (e) => {
      if (cancelled) return finish(cancelledResult());
      finish(failure(`spawn 失败: ${e.message}`));
    });

    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("close", (code, signalName) => {
      if (cancelled) return finish(cancelledResult());
      if (timedOut) return finish(failure(`hook 超时（${opts.timeoutMs}ms）已终止`));
      const parsed = parseHookOutput(stdout);
      const base = {
        output: parsed.output,
        cancelled: false,
        exitCode: code,
        elapsedMs: Date.now() - startedAt,
        stderr,
      };
      // exit 2：无条件 deny，优先于 onError。
      if (code === 2) {
        const reason = (parsed.output?.reason ?? stderrTail(stderr)).trim();
        return finish({
          ...base,
          decision: "deny",
          reason: reason || "hook 以退出码 2 阻塞（未输出原因）",
          failed: false,
        });
      }
      if (code !== 0) {
        return finish(failure(`hook 退出码 ${code ?? "null"}${signalName ? `（signal ${signalName}）` : ""}`));
      }
      // exit 0 + 空 stdout 是合法的 allow（纯审计型 hook）。
      if (stdout.trim().length === 0) {
        return finish({ ...base, decision: "allow", failed: false });
      }
      if (!parsed.output) {
        return finish(failure(parsed.error ?? "stdout 无决策 JSON"));
      }
      const mapped = readDecision(parsed.output);
      if (mapped.error) return finish(failure(mapped.error));
      return finish({
        ...base,
        decision: mapped.decision ?? "allow",
        reason: parsed.output.reason,
        failed: false,
      });
    });
  });
}
