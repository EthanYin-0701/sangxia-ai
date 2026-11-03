import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { Session } from "../session.js";
import type { Tool, ToolContext, ToolResult } from "../harness/tool.js";
import { createHeadTailBuffer, truncateMiddle } from "../harness/truncate.js";
import { bashPermissionScope } from "./scope.js";
import { resolveShell, shellSyntaxHint, type ShellSpec } from "./shell.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_BYTE_LIMIT = 1_000_000;
const IS_WINDOWS = process.platform === "win32";
/** Chosen once per process: the agent and its stdio client run on the same OS. */
const SHELL: ShellSpec = resolveShell();

function abs(session: Session, p: string): string {
  return isAbsolute(p) ? p : resolve(session.cwd, p);
}

/** Run a shell command via the client's terminal capability (preferred), keeping
 * the command visible in the editor; falls back to a local child process. */
async function runViaClientTerminal(command: string, cwd: string, timeoutMs: number, ctx: ToolContext): Promise<ToolResult> {
  const terminal = await ctx.conn.createTerminal({
    sessionId: ctx.session.id,
    command: SHELL.command,
    args: SHELL.args(command),
    cwd,
    outputByteLimit: OUTPUT_BYTE_LIMIT,
  });
  const onAbort = () => void terminal.kill().catch(() => {});
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  if (ctx.signal.aborted) onAbort();
  // M3: `waitForExit()` used to be unbounded on this path (the `timeout`
  // parameter only applied to the local fallback). Race it against the deadline
  // and kill the terminal on timeout — we stop waiting even if the client never
  // reports the exit.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onCancel = () => rejectWith(ctx.signal.reason ?? new Error("aborted"));
  let rejectWith: (reason: unknown) => void = () => {};
  try {
    const exit = await Promise.race([
      terminal.waitForExit(),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          onAbort();
          resolve("timeout");
        }, timeoutMs);
      }),
      new Promise<never>((_, reject) => {
        rejectWith = reject;
        if (ctx.signal.aborted) onCancel();
        else ctx.signal.addEventListener("abort", onCancel, { once: true });
      }),
    ]);
    if (exit === "timeout") {
      return {
        output: `Error: 命令执行超时（${timeoutMs}ms）已终止；可缩小任务范围或显式设置 timeout 后重试`,
        isError: true,
        raw: { timedOut: true },
      };
    }
    const out = await terminal.currentOutput();
    const code = exit.exitCode ?? null;
    const header = `exit=${code ?? `signal:${exit.signal ?? "?"}`}`;
    // H3③: the client owns `outputByteLimit`, so its tail fidelity is up to the
    // client. Still cap what *we* feed back to the model (head+tail).
    return {
      output: truncateMiddle(`${header}\n${out.output}`.trim() || header, OUTPUT_BYTE_LIMIT),
      isError: code !== 0,
      raw: { exitCode: code, signal: exit.signal ?? null, truncated: out.truncated },
    };
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
    ctx.signal.removeEventListener("abort", onCancel);
    await terminal.release().catch(() => {});
  }
}

/** Local fallback when the client doesn't expose a terminal. */
function runViaChildProcess(
  command: string,
  cwd: string,
  timeoutMs: number,
  ctx: ToolContext,
): Promise<ToolResult> {
  return new Promise((resolvePromise) => {
    // Spawn the per-OS shell explicitly (not `shell: true`, which is cmd.exe on
    // Windows and would contradict the tool description).
    // M3: on POSIX `detached: true` puts the shell in its own process group, so
    // we can kill the *tree* — a plain child.kill() only reaps the wrapper shell
    // while `npm run …`'s node grandchildren keep running. On Windows `detached`
    // would open a new console window instead; the tree is killed via taskkill.
    const child = spawn(SHELL.command, SHELL.args(command), { cwd, detached: !IS_WINDOWS, windowsHide: true });
    // H3③: keep both ends of the output instead of swallowing everything after
    // the limit — test/build failures are reported at the tail.
    const buffer = createHeadTailBuffer(OUTPUT_BYTE_LIMIT);
    const append = (chunk: Buffer) => buffer.push(chunk.toString("utf8"));
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const killTree = () => {
      if (child.pid === undefined) return;
      if (IS_WINDOWS) {
        // No process groups on Windows: `taskkill /T` walks the child tree.
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill("SIGKILL"));
        return;
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // -pid may already be gone.
        child.kill("SIGKILL");
      }
    };
    const onAbort = () => killTree();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    };
    child.on("error", (err) => {
      cleanup();
      resolvePromise({ output: `Error: 无法执行命令: ${err.message}`, isError: true });
    });
    child.on("close", (code, signal) => {
      cleanup();
      const header = timedOut
        ? `Error: 命令执行超时（${timeoutMs}ms）已终止`
        : `exit=${code ?? `signal:${signal ?? "?"}`}`;
      resolvePromise({
        output: `${header}\n${buffer.text()}`.trim() || header,
        isError: timedOut || code !== 0,
        raw: { exitCode: code, signal, droppedBytes: buffer.dropped(), timedOut },
      });
    });
  });
}

export const bashTool: Tool = {
  name: "bash",
  description:
    `在 shell 中执行命令（当前系统：${SHELL.label}）。用于构建、测试、git、安装依赖等。返回退出码与合并的 stdout/stderr。` +
    `${shellSyntaxHint(SHELL)}每次调用都是独立进程，设置的环境变量不会保留到下一次调用。`,
  kind: "execute",
  needsPermission: true,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的 shell 命令" },
      cwd: { type: "string", description: "工作目录(相对或绝对，默认会话工作目录)" },
      timeout: { type: "number", description: "超时毫秒数(默认 120000)，本地与客户端终端路径均生效" },
    },
    required: ["command"],
  },
  title: (a) => `执行 ${String(a.command).split("\n")[0]}`,
  permissionScope: (a, s) => bashPermissionScope("bash", s, String(a.command ?? ""), a.cwd ? abs(s, String(a.cwd)) : s.cwd),
  run: async (a, ctx) => {
    ctx.signal.throwIfAborted();
    const command = String(a.command ?? "");
    if (!command.trim()) return { output: "Error: command 为空", isError: true };
    const cwd = a.cwd ? abs(ctx.session, String(a.cwd)) : ctx.session.cwd;
    const timeoutMs = typeof a.timeout === "number" ? a.timeout : DEFAULT_TIMEOUT_MS;

    if (ctx.session.clientCaps.terminal) {
      return runViaClientTerminal(command, cwd, timeoutMs, ctx);
    }
    return runViaChildProcess(command, cwd, timeoutMs, ctx);
  },
};
