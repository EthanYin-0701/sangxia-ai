import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { HOOK_EVENTS, type HookEntry } from "./types.js";

/**
 * Hook 命令的加载期处理：路径形态判定、路径解析与存在性校验（fail fast）。
 *
 * 设计见 `plan/hooks_support.md` §4-6 / §10-D15（review H2 的结论）：
 *
 * - **解析基准 = 声明它的那份配置所在目录**，绝不是 session cwd。
 *   配置级 hook（`zhente.config.json` / `$ZHENTE_CONFIG` / `~/.config/zhente/config.json`）
 *   相对**声明它的那个配置文件目录**（分层加载后全局 base 与项目 overlay 各按自己的目录，
 *   见 D16）；项目级 hook（`.zhente/hooks.json`）相对**项目根**。
 *   若基准取 session cwd，全局配置里一句 `.zhente/hooks/guard.sh` 就会在打开任意
 *   恶意仓库时执行该仓库里的同名脚本（供应链风险）。
 * - hook 进程的**运行时 cwd 仍是 session cwd**（脚本里的 `git status` / `npm` 语义不变），
 *   两个概念解耦：基准决定"跑哪个文件"，cwd 决定"文件里看到的工作目录"。
 * - 路径形态的命令在加载期解析成绝对路径并校验存在性：否则会退化成"每次调用都失败 +
 *   `onError` 默认 allow"，一条拦截策略静默失效。
 */

const SCRIPT_SUFFIXES = [".sh", ".bash", ".mjs", ".cjs", ".js", ".cmd", ".bat", ".ps1"];

/** 命令的第一个 token 是否按"路径形态"处理（见 §4-6 的判定规则）。 */
export function isPathLikeCommand(command: string): boolean {
  const token = command.trim().split(/\s+/)[0] ?? "";
  if (!token) return false;
  if (token === "~" || token.startsWith("~/")) return true;
  if (token.startsWith("./") || token.startsWith("../") || token.startsWith("/")) return true;
  if (token.includes("/") || token.includes("\\")) return true;
  return SCRIPT_SUFFIXES.some((suffix) => token.toLowerCase().endsWith(suffix));
}

/** `~` / `~/…` → home。不交给 shell 展开，保证两个分支行为一致（D15）。 */
function expandHome(token: string): string {
  if (token === "~") return homedir();
  if (token.startsWith("~/")) return resolve(homedir(), token.slice(2));
  return token;
}

const KNOWN_EVENTS: readonly string[] = HOOK_EVENTS;

/**
 * 校验 `hooks.events` 的键都是合法事件名。
 *
 * 不说的话，`sessionStart`（驼峰）这类笔误会**静默什么都不做** —— hook 永远不跑，
 * 而用户以为自己配上了（与 D14 的"忽略 matcher"同类陷阱），因此加载期直接报错。
 */
export function assertKnownHookEvents(events: Record<string, unknown>, where: string): void {
  for (const key of Object.keys(events)) {
    if (!KNOWN_EVENTS.includes(key)) {
      throw new Error(`${where}: 未知事件名 "${key}"（合法取值：${KNOWN_EVENTS.join(" / ")}）`);
    }
  }
}

/**
 * 校验 matcher 正则合法性与字段取值。配置级由 zod 兜底，项目级文件不过 zod，
 * 必须在这里拦住（非法正则不能等到 turn 里才炸）。
 */
export function assertValidHookEntries(entries: HookEntry[], where: string): void {
  for (const entry of entries) {
    const label = entry.name ?? entry.command;
    if (typeof entry.command !== "string" || entry.command.trim().length === 0) {
      throw new Error(`${where}: hook "${label}" 缺少 command`);
    }
    if (entry.matcher !== undefined) {
      if (typeof entry.matcher !== "string") throw new Error(`${where}: hook "${label}" 的 matcher 必须是字符串`);
      try {
        new RegExp(entry.matcher);
      } catch (e) {
        throw new Error(`${where}: hook "${label}" 的 matcher 不是合法正则 (${entry.matcher}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (entry.timeoutMs !== undefined && !(Number.isFinite(entry.timeoutMs) && entry.timeoutMs > 0)) {
      throw new Error(`${where}: hook "${label}" 的 timeoutMs 必须是正数`);
    }
    if (entry.onError !== undefined && entry.onError !== "allow" && entry.onError !== "deny") {
      throw new Error(`${where}: hook "${label}" 的 onError 只能是 "allow" 或 "deny"`);
    }
  }
}

/**
 * 把路径形态的命令解析成绝对路径并校验存在性；内联命令（`"npm run lint"`）原样保留。
 *
 * `baseDir` 必须是**声明该配置的目录**（配置级 = 配置文件目录，项目级 = 项目根）。
 */
export function resolveHookCommands(entries: HookEntry[], baseDir: string, where: string): HookEntry[] {
  return entries.map((entry) => {
    if (!isPathLikeCommand(entry.command)) return entry;
    const parts = entry.command.trim().split(/\s+/);
    const expanded = expandHome(parts[0]!);
    const absolute = isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
    let isFile = false;
    try {
      isFile = existsSync(absolute) && statSync(absolute).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      throw new Error(
        `${where}: hook "${entry.name ?? entry.command}" 的可执行文件不存在: ${absolute}` +
          `（路径形态命令按 ${baseDir} 解析；配置级 hook 请用绝对路径或 \${HOME}/…）`,
      );
    }
    return { ...entry, command: [absolute, ...parts.slice(1)].join(" ") };
  });
}
