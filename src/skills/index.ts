import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Tool } from "../harness/tool.js";

/**
 * Lightweight skill layer (progressive disclosure, à la Claude Code Skills).
 *
 * A skill is a directory containing a `SKILL.md` with YAML-ish frontmatter:
 *
 *   ---
 *   name: my-skill
 *   description: One line shown in the catalog so the model knows when to use it.
 *   ---
 *   Full instructions (the body) — only loaded into context when the model
 *   calls `use_skill`.
 *
 * At `newSession` we scan the skill dirs, inject just the name+description
 * catalog into the system prompt, and expose `use_skill` to pull a body on demand.
 */
export interface Skill {
  name: string;
  description: string;
  /** Absolute path to the skill's SKILL.md. */
  path: string;
}

/**
 * Minimal frontmatter split — leading `---` block, `key: value` lines only.
 *
 * YAML block scalars are supported because real-world (Claude Code) skills write
 * long descriptions as `description: >-` followed by an indented block; without
 * this the catalog would show the literal `>-`. Folded (`>`/`>-`/`>+`) joins
 * lines with spaces (blank line → paragraph break), literal (`|`/`|-`/`|+`)
 * keeps newlines; both are dedented and trimmed.
 */
function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { data: {}, body: raw };
  const data: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);

  const blockValue = (style: ">" | "|", collected: string[]): string => {
    const nonEmpty = collected.filter((l) => l.trim() !== "");
    if (nonEmpty.length === 0) return "";
    const indent = Math.min(...nonEmpty.map((l) => l.length - l.trimStart().length));
    const dedented = collected.map((l) => (l.trim() === "" ? "" : l.slice(indent)));
    if (style === "|") return dedented.join("\n").trim();
    let out = "";
    for (const [i, l] of dedented.entries()) {
      if (l === "") {
        out += "\n";
        continue;
      }
      out += (i > 0 && out !== "" && !out.endsWith("\n") ? " " : "") + l;
    }
    return out.trim();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key || key.startsWith("-")) continue;
    let val = line.slice(idx + 1).trim();

    const block = /^([>|])([-+]?)$/.exec(val);
    if (block) {
      const collected: string[] = [];
      // Block ends at the first less-indented line (a new top-level key or `---`).
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        if (next.trim() !== "" && !/^\s/.test(next)) break;
        collected.push(next);
        i++;
      }
      data[key] = blockValue(block[1] as ">" | "|", collected);
      continue;
    }

    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    data[key] = val;
  }
  return { data, body: raw.slice(m[0].length) };
}

/**
 * Discover skills. Relative `extraDirs` resolve against `cwd`; an empty list
 * falls back to `<cwd>/skills` then `~/.config/sangxia/skills`. Earlier dirs win
 * on name collision, so a project skill shadows a global one of the same name.
 */
export async function discoverSkills(cwd: string, extraDirs: string[]): Promise<Skill[]> {
  const dirs =
    extraDirs.length > 0
      ? extraDirs.map((d) => (isAbsolute(d) ? d : resolve(cwd, d)))
      : [resolve(cwd, "skills"), join(homedir(), ".config", "sangxia", "skills")];

  const found = new Map<string, Skill>();
  for (const dir of dirs) {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // dir missing → skip
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const skillMd = join(dir, ent.name, "SKILL.md");
      let raw: string;
      try {
        raw = await readFile(skillMd, "utf8");
      } catch {
        continue; // no SKILL.md in this subdir
      }
      const { data } = parseFrontmatter(raw);
      const name = (data.name || ent.name).trim();
      if (found.has(name)) continue; // earlier dir wins
      found.set(name, { name, description: (data.description ?? "").trim(), path: skillMd });
    }
  }
  return [...found.values()];
}

/** The catalog block appended to the system prompt (empty string if no skills). */
export function skillCatalogPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description || "(无描述)"}`);
  return [
    "",
    "可用技能 (skills)——需要时用 use_skill 工具按名加载其完整说明后再执行:",
    ...lines,
  ].join("\n");
}

/**
 * Loads a skill's full body into the conversation. Reads from the skills the
 * session discovered at `newSession` (stored on `session.skills`).
 */
export const useSkillTool: Tool = {
  name: "use_skill",
  description:
    "加载一个技能(skill)的完整操作说明。可用技能见系统提示里的清单。传入技能名(name)，返回该技能的详细指南，随后严格按指南执行。",
  kind: "other",
  needsPermission: false,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "技能名称(见系统提示中的可用技能清单)" },
    },
    required: ["name"],
  },
  title: (a) => `加载技能 ${a?.name ?? ""}`.trim(),
  run: async (a, ctx) => {
    const name = String(a?.name ?? "").trim();
    if (!name) return { output: "Error: 缺少参数 name", isError: true };
    const skill = ctx.session.skills.find((s) => s.name === name);
    if (!skill) {
      const avail = ctx.session.skills.map((s) => s.name).join(", ") || "(无)";
      return { output: `Error: 未找到技能 "${name}"。可用技能: ${avail}`, isError: true };
    }
    try {
      const { body } = parseFrontmatter(await readFile(skill.path, "utf8"));
      return { output: body.trim() || "(该技能 SKILL.md 正文为空)" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { output: `Error: 读取技能失败: ${msg}`, isError: true };
    }
  },
};
