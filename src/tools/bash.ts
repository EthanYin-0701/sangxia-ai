import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { Session } from "../session.js";
import type { Tool, ToolContext, ToolResult } from "../harness/tool.js";

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
  try {
    const exit = await terminal.waitForExit();
    const out = await terminal.currentOutput();
    const code = exit.exitCode ?? null;
    const header = `exit=${code ?? `signal:${exit.signal ?? "?"}`}`;
    return {
      output: `${header}\n${out.output}`.trim() || header,
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
    let out = "";
    let size = 0;
    const append = (chunk: Buffer) => {
      if (size >= OUTPUT_BYTE_LIMIT) return;
      size += chunk.length;
      out += chunk.toString("utf8");
    };
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
        output: `${header}\n${out}`.trim() || header,
        isError: code !== 0,
        raw: { exitCode: code, signal },
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
