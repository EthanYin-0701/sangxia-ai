import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { Tool, ToolContext } from "../../src/harness/tool.js";
import { Session } from "../../src/session.js";
import { fsTools } from "../../src/tools/fs-tools.js";

const tool = (name: string): Tool => fsTools.find((t) => t.name === name)!;

let dir: string;
let ctx: ToolContext;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "sangxia-fs-"));
  const session = new Session("unit-fs", dir, [], { readTextFile: false, writeTextFile: false, terminal: false }, "auto", "m");
  ctx = { conn: {} as AgentSideConnection, session, signal: new AbortController().signal, toolCallId: "t" };
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe("edit_file", () => {
  // SA-22: String.replace(string, string) expanded `$$` / `$&` / `$'` / `` $` ``.
  it("writes new_string verbatim, including $ replacement patterns", async () => {
    const file = join(dir, "run.sh");
    writeFileSync(file, "echo hi\n");
    const newStr = "\"$HOME\" costs $$ and $& here $' and $`";
    const r = await tool("edit_file").run({ path: file, old_string: "hi", new_string: newStr }, ctx);
    assert.ok(!r.isError, r.output);
    assert.equal(readFileSync(file, "utf8"), `echo ${newStr}\n`);
  });

  it("keeps replace_all verbatim too", async () => {
    const file = join(dir, "Makefile");
    writeFileSync(file, "a X b X\n");
    await tool("edit_file").run({ path: file, old_string: "X", new_string: "$$var", replace_all: true }, ctx);
    assert.equal(readFileSync(file, "utf8"), "a $$var b $$var\n");
  });
});

describe("glob / grep on dot paths", () => {
  // SA-28: `dot: false` hid .github/, .sangxia/, .eslintrc …
  let root: string;
  before(() => {
    root = join(dir, "repo");
    for (const d of [".github/workflows", ".sangxia", ".git", "node_modules/.bin", "src"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, ".github/workflows/ci.yml"), "node-version: 22\n");
    writeFileSync(join(root, ".sangxia/memory.md"), "待办: x\n");
    writeFileSync(join(root, ".eslintrc"), "{}\n");
    writeFileSync(join(root, ".git/config.yml"), "node-version: git\n");
    writeFileSync(join(root, "node_modules/.bin/x.yml"), "node-version: nm\n");
    writeFileSync(join(root, "src/a.md"), "待办: y\n");
  });

  it("glob finds dot files and dirs but still skips .git / node_modules", async () => {
    const yml = await tool("glob").run({ pattern: "**/*.yml", path: root }, ctx);
    assert.deepEqual(yml.output.split("\n"), [join(root, ".github/workflows/ci.yml")]);
    const md = (await tool("glob").run({ pattern: "**/*.md", path: root }, ctx)).output.split("\n").sort();
    assert.deepEqual(md, [join(root, ".sangxia/memory.md"), join(root, "src/a.md")].sort());
    const all = (await tool("glob").run({ pattern: "*", path: root }, ctx)).output;
    assert.match(all, /\.eslintrc$/m);
  });

  it("grep searches dot files but still skips .git / node_modules", async () => {
    const r = await tool("grep").run({ pattern: "node-version", path: root }, ctx);
    assert.equal(r.output.trim(), `${join(".github", "workflows", "ci.yml")}:1: node-version: 22`);
    const todo = await tool("grep").run({ pattern: "待办", path: root }, ctx);
    assert.match(todo.output, /\.sangxia[/\\]memory\.md:1:/);
  });
});
