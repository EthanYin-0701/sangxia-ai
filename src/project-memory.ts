import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MEMORY_FILE_ALIASES = [["AGENTS.md", "AGENT.md"], [".zhente/memory.md", "memory.md"]];

async function findMemoryFile(cwd: string, names: string[]): Promise<string | null> {
  for (const name of names) {
    try {
      await readFile(join(cwd, name), "utf8");
      return name;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return null;
}

export async function missingProjectMemory(cwd: string): Promise<string[]> {
  const missing: string[] = [];
  for (const names of MEMORY_FILE_ALIASES) {
    if (!(await findMemoryFile(cwd, names))) missing.push(names[0]!);
  }
  return missing;
}

/** Load durable project instructions/context into a fresh conversation. */
export async function loadProjectMemory(cwd: string): Promise<string> {
  const sections: string[] = [];
  for (const names of MEMORY_FILE_ALIASES) {
    const name = await findMemoryFile(cwd, names);
    if (!name) continue;
    try {
      const content = (await readFile(join(cwd, name), "utf8")).trim();
      if (content) sections.push(`## ${name}\n${content}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  if (sections.length === 0) return "";
  return ["", "项目长期记忆（每次新建/恢复 session 都会加载，请在相关任务完成后维护）：", ...sections].join("\n\n");
}
