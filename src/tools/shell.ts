// Per-OS shell selection for the `bash` tool. The tool keeps its name (permission
// memory and hook matchers like `^bash$` key on it), but on Windows the command
// runs in PowerShell instead of a `bash` that usually isn't on PATH.

export type ShellKind = "bash" | "powershell";

export interface ShellSpec {
  kind: ShellKind;
  /** Executable to spawn (looked up on PATH). */
  command: string;
  /** Full argv for running `script`. */
  args: (script: string) => string[];
  /** Human/model-facing description, e.g. `bash -lc`. */
  label: string;
}

/**
 * Force UTF-8 for PowerShell's own stdout: Windows PowerShell 5.1 otherwise
 * writes in the OEM code page and Chinese output comes back garbled.
 */
const PS_UTF8_PRELUDE =
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ";

export function resolveShell(platform: NodeJS.Platform = process.platform): ShellSpec {
  if (platform === "win32") {
    return {
      kind: "powershell",
      command: "powershell.exe",
      // `-ExecutionPolicy Bypass` applies to this process only; without it the
      // default `Restricted` policy blocks the `npm.ps1`/`npx.ps1` shims.
      args: (script) => [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        PS_UTF8_PRELUDE + script,
      ],
      label: "Windows PowerShell (powershell.exe -Command)",
    };
  }
  return {
    kind: "bash",
    command: "bash",
    args: (script) => ["-lc", script],
    label: "bash -lc",
  };
}

/** Syntax hint for the model, so it doesn't write bash on PowerShell or vice versa. */
export function shellSyntaxHint(spec: ShellSpec): string {
  return spec.kind === "powershell"
    ? "使用 PowerShell 语法：环境变量用 $env:NAME 读取、$env:NAME = 'v' 设置；命令分隔用 `;`（PowerShell 5.1 不支持 `&&`/`||`）。"
    : "使用 bash 语法：环境变量用 $NAME 读取、export NAME=v 设置。";
}
