import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { Session } from "../session.js";
import type { Tool, ToolContext, ToolResult } from "../harness/tool.js";
import { createHeadTailBuffer, truncateMiddle } from "../harness/truncate.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_BYTE_LIMIT = 1_000_000;

function abs(session: Session, p: string): string {
  return isAbsolute(p) ? p : resolve(session.cwd, p);
}

/** Run a shell command via the client's terminal capability (preferred), keeping
 * the command visible in the editor; falls back to a local child process. */
async function runViaClientTerminal(command: string, cwd: string, ctx: ToolContext): Promise<ToolResult> {
  const terminal = await ctx.conn.createTerminal({
    sessionId: ctx.session.id,
    command: "bash",
    args: ["-lc", command],
    cwd,
    outputByteLimit: OUTPUT_BYTE_LIMIT,
  });
  const onAbort = () => void terminal.kill().catch(() => {});
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  if (ctx.signal.aborted) onAbort();
  try {
    const exit = await terminal.waitForExit();
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
    ctx.signal.removeEventListener("abort", onAbort);
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
    const child = spawn(command, { shell: true, cwd, signal: ctx.signal });
    // H3③: keep both ends of the output instead of swallowing everything after
    // the limit — test/build failures are reported at the tail.
    const buffer = createHeadTailBuffer(OUTPUT_BYTE_LIMIT);
    const append = (chunk: Buffer) => buffer.push(chunk.toString("utf8"));
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ output: `Error: 无法执行命令: ${err.message}`, isError: true });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const header = `exit=${code ?? `signal:${signal ?? "?"}`}`;
      resolvePromise({
        output: `${header}\n${buffer.text()}`.trim() || header,
        isError: code !== 0,
        raw: { exitCode: code, signal, droppedBytes: buffer.dropped() },
      });
    });
  });
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "在 shell 中执行命令(bash -lc)。用于构建、测试、git、安装依赖等。返回退出码与合并的 stdout/stderr。",
  kind: "execute",
  needsPermission: true,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的 shell 命令" },
      cwd: { type: "string", description: "工作目录(相对或绝对，默认会话工作目录)" },
      timeout: { type: "number", description: "超时毫秒数(默认 120000，仅本地回退时生效)" },
    },
    required: ["command"],
  },
  title: (a) => `执行 ${String(a.command).split("\n")[0]}`,
  run: async (a, ctx) => {
    ctx.signal.throwIfAborted();
    const command = String(a.command ?? "");
    if (!command.trim()) return { output: "Error: command 为空", isError: true };
    const cwd = a.cwd ? abs(ctx.session, String(a.cwd)) : ctx.session.cwd;
    const timeoutMs = typeof a.timeout === "number" ? a.timeout : DEFAULT_TIMEOUT_MS;

    if (ctx.session.clientCaps.terminal) {
      return runViaClientTerminal(command, cwd, ctx);
    }
    return runViaChildProcess(command, cwd, timeoutMs, ctx);
  },
};
