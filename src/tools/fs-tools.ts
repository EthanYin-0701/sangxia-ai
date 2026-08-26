import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { glob as tinyglob } from "tinyglobby";
import type { Session } from "../session.js";
import type { Tool, ToolContext } from "../harness/tool.js";

const IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.next/**"];

/** Resolve a possibly-relative path against the session cwd (ACP needs absolute paths). */
function abs(session: Session, p: string): string {
  return isAbsolute(p) ? p : resolve(session.cwd, p);
}

/** Read text, preferring the client's file system (keeps the editor in sync). */
async function readText(
  ctx: ToolContext,
  path: string,
  line?: number,
  limit?: number,
): Promise<string> {
  if (ctx.session.clientCaps.readTextFile) {
    const res = await ctx.conn.readTextFile({
      sessionId: ctx.session.id,
      path,
      line: line ?? null,
      limit: limit ?? null,
    });
    return res.content;
  }
  let content = await readFile(path, "utf8");
  if (line != null || limit != null) {
    const lines = content.split("\n");
    const start = Math.max(0, (line ?? 1) - 1);
    const end = limit != null ? start + limit : undefined;
    content = lines.slice(start, end).join("\n");
  }
  return content;
}

/** Write text, preferring the client's file system. */
async function writeText(ctx: ToolContext, path: string, content: string): Promise<void> {
  if (ctx.session.clientCaps.writeTextFile) {
    await ctx.conn.writeTextFile({ sessionId: ctx.session.id, path, content });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

const readFileTool: Tool = {
  name: "read_file",
  description:
    "读取一个文本文件的内容。可选按起始行(line, 1-based)和行数(limit)截取。路径可相对当前工作目录。",
  kind: "read",
  needsPermission: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径(相对或绝对)" },
      line: { type: "number", description: "起始行(1-based，可选)" },
      limit: { type: "number", description: "最多读取的行数(可选)" },
    },
    required: ["path"],
  },
  title: (a) => `读取 ${a.path}`,
  locations: (a, s) => [{ path: abs(s, String(a.path)) }],
  run: async (a, ctx) => {
    const path = abs(ctx.session, String(a.path));
    const content = await readText(ctx, path, a.line, a.limit);
    return { output: content };
  },
};

const writeFileTool: Tool = {
  name: "write_file",
  description: "把内容写入文件(存在则覆盖，不存在则创建，含父目录)。路径可相对当前工作目录。",
  kind: "edit",
  needsPermission: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径(相对或绝对)" },
      content: { type: "string", description: "要写入的完整内容" },
    },
    required: ["path", "content"],
  },
  title: (a) => `写入 ${a.path}`,
  locations: (a, s) => [{ path: abs(s, String(a.path)) }],
  run: async (a, ctx) => {
    const path = abs(ctx.session, String(a.path));
    const content = String(a.content ?? "");
    await writeText(ctx, path, content);
    return { output: `已写入 ${path}（${content.length} 字符）` };
  },
};

const editFileTool: Tool = {
  name: "edit_file",
  description:
    "对文件做精确字符串替换：把 old_string 替换为 new_string。默认要求 old_string 在文件中唯一出现；如需替换全部，设 replace_all=true。",
  kind: "edit",
  needsPermission: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径(相对或绝对)" },
      old_string: { type: "string", description: "要被替换的原文(需与文件内容精确匹配)" },
      new_string: { type: "string", description: "替换后的新内容" },
      replace_all: { type: "boolean", description: "是否替换所有匹配(默认 false)" },
    },
    required: ["path", "old_string", "new_string"],
  },
  title: (a) => `编辑 ${a.path}`,
  locations: (a, s) => [{ path: abs(s, String(a.path)) }],
  run: async (a, ctx) => {
    const path = abs(ctx.session, String(a.path));
    const oldStr = String(a.old_string ?? "");
    const newStr = String(a.new_string ?? "");
    const replaceAll = Boolean(a.replace_all);

    if (oldStr === "") return { output: "Error: old_string 不能为空", isError: true };
    if (oldStr === newStr) return { output: "Error: old_string 与 new_string 相同", isError: true };

    const current = await readText(ctx, path);
    const count = current.split(oldStr).length - 1;
    if (count === 0) return { output: `Error: 在 ${path} 中未找到 old_string`, isError: true };
    if (count > 1 && !replaceAll) {
      return {
        output: `Error: old_string 在 ${path} 中出现 ${count} 次；请提供更精确的上下文，或设 replace_all=true`,
        isError: true,
      };
    }

    const next = replaceAll ? current.split(oldStr).join(newStr) : current.replace(oldStr, newStr);
    await writeText(ctx, path, next);
    return { output: `已编辑 ${path}（替换 ${replaceAll ? count : 1} 处）` };
  },
};

const listDirTool: Tool = {
  name: "list_dir",
  description: "列出目录下的条目(目录以 / 结尾)。默认列出当前工作目录。",
  kind: "read",
  needsPermission: false,
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "目录路径(相对或绝对，可选)" } },
  },
  title: (a) => `列目录 ${a.path ?? "."}`,
  run: async (a, ctx) => {
    const dir = a.path ? abs(ctx.session, String(a.path)) : ctx.session.cwd;
    const entries = await readdir(dir, { withFileTypes: true });
    const lines = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((x, y) => x.localeCompare(y));
    return { output: lines.join("\n") || "(空目录)" };
  },
};

const globTool: Tool = {
  name: "glob",
  description:
    "按 glob 模式查找文件(如 'src/**/*.ts')。返回匹配的绝对路径。自动忽略 node_modules/.git/dist。",
  kind: "search",
  needsPermission: false,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "glob 模式" },
      path: { type: "string", description: "搜索根目录(相对或绝对，默认当前工作目录)" },
    },
    required: ["pattern"],
  },
  title: (a) => `查找 ${a.pattern}`,
  run: async (a, ctx) => {
    const cwd = a.path ? abs(ctx.session, String(a.path)) : ctx.session.cwd;
    const matches = await tinyglob(String(a.pattern), {
      cwd,
      absolute: true,
      dot: false,
      ignore: IGNORE,
    });
    if (matches.length === 0) return { output: "(无匹配)" };
    const shown = matches.slice(0, 500);
    const extra = matches.length - shown.length;
    return {
      output: shown.join("\n") + (extra > 0 ? `\n… 还有 ${extra} 个未显示` : ""),
      raw: { count: matches.length },
    };
  },
};

const grepTool: Tool = {
  name: "grep",
  description:
    "在文件内容中按正则搜索，返回 path:line: 匹配行。可用 glob 限定搜索的文件(默认全部)。",
  kind: "search",
  needsPermission: false,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "正则表达式(JavaScript 语法)" },
      path: { type: "string", description: "搜索根目录(默认当前工作目录)" },
      glob: { type: "string", description: "限定搜索的文件 glob(如 '**/*.ts'，默认 '**/*')" },
    },
    required: ["pattern"],
  },
  title: (a) => `搜索 /${a.pattern}/`,
  run: async (a, ctx) => {
    const root = a.path ? abs(ctx.session, String(a.path)) : ctx.session.cwd;
    let re: RegExp;
    try {
      re = new RegExp(String(a.pattern));
    } catch (e) {
      return { output: `Error: 无效正则: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }

    const files = await tinyglob(a.glob ? String(a.glob) : "**/*", {
      cwd: root,
      absolute: true,
      dot: false,
      ignore: IGNORE,
    });

    const results: string[] = [];
    const MAX = 200;
    outer: for (const file of files.slice(0, 5000)) {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue; // unreadable
      }
      if (text.includes(String.fromCharCode(0))) continue; // skip binary
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i]!;
        if (re.test(lineText)) {
          results.push(`${relative(root, file)}:${i + 1}: ${lineText.trim()}`);
          if (results.length >= MAX) break outer;
        }
      }
    }

    if (results.length === 0) return { output: "(无匹配)" };
    return { output: results.join("\n"), raw: { matches: results.length } };
  },
};

export const fsTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  globTool,
  grepTool,
];
