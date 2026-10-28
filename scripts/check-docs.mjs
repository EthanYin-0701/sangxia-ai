#!/usr/bin/env node
// Doc drift check for the agent-facing docs (SA-4). No build needed:
//   node scripts/check-docs.mjs   (npm run check:docs)
//
// AGENTS.md is injected verbatim into the system prompt of every session, and
// CLAUDE.md is the orientation for coding agents working on this repo, so both
// must only point at files that exist in a fresh clone and must not contradict
// the code. Checks:
//   1. every repo path mentioned in CLAUDE.md / AGENTS.md (and every relative
//      markdown link in README.md / INSTRUCTIONS.md) exists in git;
//   2. every `npm run <script>` mentioned exists in package.json;
//   3. CLAUDE.md lists every file in src/harness/ and describes the session
//      file as `.jsonl` (persistence.ts is an append-only JSONL event log);
//   4. every `TODO(<tag>)` marker CLAUDE.md mentions still exists in src/;
//   5. AGENTS.md stays under a size budget (it costs prompt tokens every request).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_MD_BUDGET_BYTES = 8 * 1024;

// Paths that are created at runtime / per developer and gitignored on purpose.
// Mentioning them is fine; they are not expected in a clone.
const RUNTIME_PATHS = new Set([".sangxia/memory.md", ".sangxia/hooks.json", "sangxia.config.json", "dist/", "node_modules/"]);

const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
const trackedSet = new Set(tracked);
const trackedDirs = new Set(tracked.flatMap((f) => f.split("/").slice(0, -1).map((_, i, parts) => `${parts.slice(0, i + 1).join("/")}/`)));
const trackedBasenames = new Set(tracked.map((f) => basename(f)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const read = (f) => readFileSync(join(root, f), "utf8");

const failures = [];
const fail = (file, msg) => failures.push(`${file}: ${msg}`);

function pathExists(p) {
  if (RUNTIME_PATHS.has(p)) return true;
  if (p.endsWith("/")) return trackedDirs.has(p) || trackedDirs.has(`src/${p}`);
  if (!p.includes("/")) return trackedBasenames.has(p);
  // src/ is implied in prose such as `harness/loop.ts`.
  return trackedSet.has(p) || trackedSet.has(`src/${p}`);
}

/** Repo-relative path-looking tokens inside inline code spans. */
function codePaths(text) {
  const out = new Set();
  for (const [, span] of text.matchAll(/`([^`\n]+)`/g)) {
    for (const token of span.split(/[\s,，、（）()]+/)) {
      const t = token.replace(/^\.\//, "").replace(/[:;。]+$/, "");
      if (!t || /^[~$<\/]|[<>*{}]|:\/\/|^-/.test(t)) continue; // home/env/placeholder/glob/URL/flag
      if (/\.(md|ts|mjs|json|sh|svg)$/.test(t) || (/^[\w.-]+(\/[\w.-]+)*\/$/.test(t) && t.includes("/"))) out.add(t);
    }
  }
  return out;
}

// 1. Paths.
for (const file of ["CLAUDE.md", "AGENTS.md"]) {
  for (const p of codePaths(read(file))) if (!pathExists(p)) fail(file, `references missing path \`${p}\``);
}
for (const file of ["CLAUDE.md", "AGENTS.md", "README.md", "INSTRUCTIONS.md"]) {
  for (const [, target] of read(file).matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const p = target.split("#")[0];
    if (!pathExists(p)) fail(file, `links to missing path ${target}`);
  }
}

// 2. npm scripts (INSTRUCTIONS.md also quotes user-side commands such as `npm run lint`).
for (const file of ["CLAUDE.md", "AGENTS.md"]) {
  for (const [, name] of read(file).matchAll(/npm run ([\w:-]+)/g)) {
    if (!pkg.scripts?.[name]) fail(file, `mentions \`npm run ${name}\`, which package.json does not define`);
  }
}

// 3. CLAUDE.md facts that drifted before.
const claude = read("CLAUDE.md");
for (const f of tracked.filter((f) => f.startsWith("src/harness/"))) {
  if (!claude.includes(basename(f))) fail("CLAUDE.md", `harness/ description does not mention ${basename(f)}`);
}
for (const [m] of claude.matchAll(/<sessionId>\.\w+/g)) {
  if (m !== "<sessionId>.jsonl") fail("CLAUDE.md", `describes the session file as ${m}; persistence.ts writes <sessionId>.jsonl`);
}

// 4. TODO markers.
const srcText = tracked.filter((f) => f.startsWith("src/")).map(read).join("\n");
for (const [m] of claude.matchAll(/TODO\([\w-]+\)/g)) {
  if (!srcText.includes(m)) fail("CLAUDE.md", `mentions ${m} markers, but none exist in src/`);
}

// 5. Size budget.
const agentsBytes = Buffer.byteLength(read("AGENTS.md"), "utf8");
if (agentsBytes > AGENTS_MD_BUDGET_BYTES) {
  fail("AGENTS.md", `${agentsBytes} bytes exceeds the ${AGENTS_MD_BUDGET_BYTES}-byte budget (it is sent with every request)`);
}

if (failures.length > 0) {
  process.stderr.write(`check-docs: ${failures.length} problem(s)\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exit(1);
}
process.stderr.write(`check-docs: ok (AGENTS.md ${agentsBytes} bytes)\n`);
