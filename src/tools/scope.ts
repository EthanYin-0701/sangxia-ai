// Permission scopes for the built-in tools (SA-1): workspace boundary for file
// tools, command-prefix memory and high-risk command detection for `bash`.
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { PermissionScope } from "../harness/tool.js";
import type { Session } from "../session.js";

/** Memory key: `tool` approved for everything under directory `dir`. */
export function dirPermissionKey(tool: string, dir: string): string {
  return `${tool}:dir:${dir}`;
}

function filePermissionKey(tool: string, file: string): string {
  return `${tool}:file:${file}`;
}

/**
 * Canonical path: realpath of the nearest existing ancestor plus the
 * not-yet-existing tail, so a symlink inside the workspace can't point the
 * boundary check elsewhere and a file about to be created still resolves.
 */
export async function canonicalPath(p: string): Promise<string> {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(p);
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

/** Whether `target` is `root` or lies below it (both canonical). */
export function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** `p` and all its ancestors, deepest first. */
function ancestors(p: string): string[] {
  const out: string[] = [];
  for (let cur = p; ; cur = dirname(cur)) {
    out.push(cur);
    if (dirname(cur) === cur) return out;
  }
}

/** A glob pattern that can reach outside its search root. */
function globEscapes(pattern: string): boolean {
  return isAbsolute(pattern) || pattern.startsWith("~") || pattern.split(/[\\/]/).includes("..");
}

/**
 * Scope of a file-tool call on `target` (absolute). Inside the workspace,
 * "always" covers the containing directory subtree; outside it, it covers only
 * that exact path, and the call is forced to prompt even for reads.
 */
export async function pathPermissionScope(
  tool: string,
  session: Session,
  target: string,
  opts: { isDir?: boolean; pattern?: string } = {},
): Promise<PermissionScope> {
  const [real, root] = await Promise.all([canonicalPath(target), canonicalPath(session.cwd)]);
  const inside = isWithin(root, real);
  const dir = opts.isDir ? real : dirname(real);
  const escapes = opts.pattern !== undefined && globEscapes(opts.pattern);
  const lookup = [filePermissionKey(tool, real), ...ancestors(dir).map((d) => dirPermissionKey(tool, d))];
  if (escapes) {
    // The pattern, not `target`, decides what is read: remember it verbatim.
    const key = filePermissionKey(tool, `${real}${sep}${opts.pattern}`);
    return {
      lookup: [key],
      remember: key,
      label: `仅此模式 ${opts.pattern}`,
      forceAsk: `模式 ${opts.pattern} 可能匹配工作区之外的文件`,
    };
  }
  if (!inside) {
    return {
      lookup,
      remember: filePermissionKey(tool, real),
      label: `仅此路径 ${real}`,
      forceAsk: `路径 ${real} 位于工作区 ${root} 之外`,
    };
  }
  return {
    lookup,
    remember: dirPermissionKey(tool, dir),
    label: `${relative(root, dir) || "."} 目录下`,
  };
}

// ── bash ──

/** Shell syntax that chains/redirects/substitutes: such a command is only ever remembered verbatim. */
const COMPOUND = /[;&|<>`\n\r]|\$\(/;
/** A second token that looks like a subcommand (`npm test`, `git status`). */
const SUBCOMMAND = /^[a-zA-Z][\w:.-]*$/;

/** Split into command segments (on `;`, `&&`, `||`, `|`, `&`, newlines) and whitespace tokens. */
function segments(command: string): string[][] {
  return command
    .split(/&&|\|\||[;|&\n\r]/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^["']|["']$/g, "")))
    .filter((t) => t.length > 0);
}

/** Drop wrappers that don't change what runs: env assignments, `sudo`/`env`/`command`/`exec`/... */
function stripWrappers(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || ["sudo", "env", "command", "exec", "nohup", "time", "xargs", "doas"].includes(t)) {
      i++;
      // `sudo -u root …`: skip wrapper flags too.
      while (i < tokens.length && tokens[i]!.startsWith("-")) i++;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

/** `/`, `/*`, `~`, `$HOME`, `*`, `.`, `..` or a top-level system dir like `/etc`. */
function isCriticalTarget(t: string): boolean {
  return /^(\/\*?|~\/?\*?|\$\{?HOME\}?\/?\*?|\*|\.\/?\*?|\.\.\/?|\/[^/\s]+\/?\*?)$/.test(t);
}

const SHELLS = ["sh", "bash", "zsh", "dash", "ksh", "fish"];

const DANGEROUS_PATTERNS: [RegExp, string][] = [
  [/\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(env\s+)?(ba|z|k|da|fi)?sh\b/, "下载内容直接交给 shell 执行"],
  [/\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(python[0-9.]*|perl|ruby|node)\b/, "下载内容直接交给解释器执行"],
  [/\b(ba|z|k|da)?sh\s+(-c\s+)?["']?(<\(|\$\()\s*(curl|wget)\b/, "下载内容直接交给 shell 执行"],
  [/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, "fork 炸弹"],
  [/>\s*\/dev\/(sd|hd|vd|xvd|nvme|disk|mmcblk)/, "直接写块设备"],
];

/**
 * Reason `command` is high-risk, or `undefined`. High-risk commands always
 * prompt: in `auto` mode, and regardless of any remembered "always allow".
 */
export function detectDangerousCommand(command: string): string | undefined {
  for (const [re, reason] of DANGEROUS_PATTERNS) if (re.test(command)) return `高危命令：${reason}`;
  for (const raw of segments(command)) {
    const tokens = stripWrappers(raw);
    const wrappers = raw.slice(0, raw.length - tokens.length);
    const escalation = wrappers.find((t) => t === "sudo" || t === "doas");
    if (escalation) return `高危命令：${escalation} 提权执行`;
    const cmd = basename(tokens[0] ?? "");
    const args = tokens.slice(1);
    // `bash -c "rm -rf /"`, `eval "…"`: inspect the inner command too.
    if (cmd === "eval") {
      const inner = detectDangerousCommand(args.join(" "));
      if (inner) return inner;
    }
    if (SHELLS.includes(cmd) && args[0] && /^-[a-z]*c$/.test(args[0])) {
      const inner = detectDangerousCommand(args.slice(1).join(" "));
      if (inner) return inner;
    }
    const flags = args.filter((a) => a.startsWith("-"));
    const targets = args.filter((a) => !a.startsWith("-"));
    const shortFlag = (c: string) => flags.some((f) => /^-[^-]/.test(f) && f.includes(c));
    if (cmd === "rm") {
      const recursive = shortFlag("r") || shortFlag("R") || flags.includes("--recursive");
      const force = shortFlag("f") || flags.includes("--force");
      if (recursive && (force || targets.some(isCriticalTarget))) return "高危命令：rm 递归删除";
    }
    if (["chmod", "chown", "chgrp"].includes(cmd) && (shortFlag("R") || flags.includes("--recursive")) && targets.some(isCriticalTarget)) {
      return `高危命令：${cmd} 递归修改系统/主目录权限`;
    }
    if (/^mkfs(\.|$)/.test(cmd) || ["mke2fs", "wipefs", "fdisk", "sfdisk", "parted"].includes(cmd)) return `高危命令：${cmd} 格式化/改写磁盘`;
    if (cmd === "dd" && args.some((a) => a.startsWith("of=/dev/"))) return "高危命令：dd 写设备";
    if (["shutdown", "reboot", "halt", "poweroff"].includes(cmd)) return `高危命令：${cmd}`;
    if (cmd === "git") {
      const sub = args.find((a) => !a.startsWith("-"));
      if (sub === "push" && args.some((a) => a === "-f" || a === "--force" || a.startsWith("--force-with-lease") || /^\+/.test(a))) return "高危命令：git 强制推送";
      if (sub === "reset" && args.includes("--hard")) return "高危命令：git reset --hard";
      if (sub === "clean" && args.some((a) => /^-[^-]*f/.test(a) || a === "--force")) return "高危命令：git clean 删除未跟踪文件";
    }
  }
  return undefined;
}

/**
 * Remembered prefix of a simple command: the program plus a subcommand-like
 * second token (`npm test`, `git status`, `ls`). `undefined` for compound
 * commands (chains, pipes, redirects, substitutions), which only match verbatim.
 */
export function commandPrefix(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed || COMPOUND.test(trimmed)) return undefined;
  const tokens = trimmed.split(/\s+/);
  const first = tokens[0]!;
  const second = tokens[1];
  return second && SUBCOMMAND.test(second) ? `${first} ${second}` : first;
}

/** Scope of a `bash` call: tool + command prefix, high-risk detection, cwd boundary. */
export async function bashPermissionScope(tool: string, session: Session, command: string, cwd: string): Promise<PermissionScope> {
  const trimmed = command.trim();
  const [realCwd, root] = await Promise.all([canonicalPath(cwd), canonicalPath(session.cwd)]);
  const danger = detectDangerousCommand(trimmed);
  const outside = isWithin(root, realCwd) ? undefined : `工作目录 ${realCwd} 位于工作区 ${root} 之外`;
  // Outside the workspace a prefix approved inside it must not apply: remember
  // only this exact command in this exact directory.
  const prefix = outside ? undefined : commandPrefix(trimmed);
  const exactKey = outside ? `${tool}:exact@${realCwd}:${trimmed}` : `${tool}:exact:${trimmed}`;
  const prefixKey = prefix ? `${tool}:prefix:${prefix}` : undefined;
  return {
    lookup: prefixKey ? [exactKey, prefixKey] : [exactKey],
    remember: prefixKey ?? exactKey,
    label: prefix ? `以 ${prefix} 开头的命令` : "仅此完整命令",
    ...(danger || outside ? { forceAsk: danger ?? outside } : {}),
    ...(danger ? { ignoreRemembered: true } : {}),
  };
}
