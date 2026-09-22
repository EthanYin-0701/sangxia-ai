import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MEMORY_FILE_ALIASES = [["AGENTS.md", "AGENT.md"], [".sangxia/memory.md", "memory.md"]];

/**
 * 用户级（全局）长期指令：`~/.config/sangxia/AGENTS.md`。
 *
 * 与项目记忆分开、**永远**加载（每个项目、每次 new/load session），用来放"无论打开
 * 哪个仓库都成立"的偏好 —— 例如某个 CLI 的用法约定、语义搜索优先于 grep 之类的
 * 工作方式。对应 codex 的 `~/.codex/AGENTS.md`、Claude Code 的 `~/.claude/CLAUDE.md`。
 *
 * 刻意**不**自动创建：它是用户的个人文件，缺省就是"没有全局指令"。
 * 路径在调用时求值（不是模块加载时），否则会冻住启动时的 HOME。
 */
function userMemoryDir(): string {
  return join(homedir(), ".config", "sangxia");
}

interface MemoryHit {
  name: string;
  content: string;
}

async function readMemoryFile(dir: string, names: string[]): Promise<MemoryHit | null> {
  for (const name of names) {
    try {
      const content = (await readFile(join(dir, name), "utf8")).trim();
      return { name, content };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return null;
}

export async function missingProjectMemory(cwd: string): Promise<string[]> {
  const missing: string[] = [];
  for (const names of MEMORY_FILE_ALIASES) {
    if (!(await readMemoryFile(cwd, names))) missing.push(names[0]!);
  }
  return missing;
}

/** Load durable project instructions/context into a fresh conversation. */
export async function loadProjectMemory(cwd: string): Promise<string> {
  const sections: string[] = [];
  for (const names of MEMORY_FILE_ALIASES) {
    const hit = await readMemoryFile(cwd, names);
    if (!hit || !hit.content) continue;
    sections.push(`## ${hit.name}\n${hit.content}`);
  }
  if (sections.length === 0) return "";
  return ["", "项目长期记忆（每次新建/恢复 session 都会加载，请在相关任务完成后维护）：", ...sections].join("\n\n");
}

/** Load the user-level instructions (`~/.config/sangxia/AGENTS.md`), if any. */
export async function loadUserMemory(): Promise<string> {
  const dir = userMemoryDir();
  const hit = await readMemoryFile(dir, ["AGENTS.md", "AGENT.md"]);
  if (!hit || !hit.content) return "";
  return [
    "",
    `用户级长期指令（来自 ${join(dir, hit.name)}，所有项目、每次 session 都会加载）：`,
    hit.content,
  ].join("\n\n");
}
