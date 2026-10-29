// Regression tests for scripts/check-docs.mjs (SA-15..SA-18, SA-21).
//
// Each case builds a throwaway git repo (the checker reads `git ls-files`),
// copies the checker into its scripts/, mutates a known-good fixture and runs
// it. No build needed:
//
// Run: node scripts/smoke-check-docs.mjs   (npm run smoke:check-docs)

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const checker = join(dirname(fileURLToPath(import.meta.url)), "check-docs.mjs");

const HARNESS = "- **`harness/`**: `harness/loop.ts` (one turn).\n";
const BASE = {
  "package.json": JSON.stringify({ scripts: { "check:docs": "node scripts/check-docs.mjs" } }),
  "CLAUDE.md": `# CLAUDE\n\nRun \`npm run check:docs\`. Config lives in \`config.ts\`; imports need the \`.js\` extension.\n${HARNESS}`,
  "AGENTS.md": "# AGENTS\n\nSee `INSTRUCTIONS.md`.\n",
  "README.md": "# README\n\nSee [docs](INSTRUCTIONS.md).\n",
  "INSTRUCTIONS.md": "# INSTRUCTIONS\n\nThe turn loop is `src/harness/loop.ts`; build output is `dist/index.js`.\n",
  "src/config.ts": "export {};\n",
  "src/harness/loop.ts": "export {};\n",
};

/** Run the checker on BASE patched with `files` (a `null` value removes the file). */
function run(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sangxia-check-docs-"));
  try {
    const all = { ...BASE, ...files };
    for (const [rel, content] of Object.entries(all)) {
      if (content === null) continue;
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    mkdirSync(join(dir, "scripts"), { recursive: true });
    copyFileSync(checker, join(dir, "scripts", "check-docs.mjs"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const r = spawnSync(process.execPath, [join(dir, "scripts", "check-docs.mjs")], { cwd: dir, encoding: "utf8" });
    return { code: r.status, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cases = [
  ["baseline fixture passes", () => {
    const r = run();
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /check-docs: ok/);
  }],

  // SA-15: a same-named file elsewhere must not keep a stale bare reference alive.
  ["SA-15 stale `config.ts` is reported although scripts/config.ts exists", () => {
    const r = run({ "src/config.ts": null, "src/configuration.ts": "export {};\n", "scripts/config.ts": "export {};\n" });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /CLAUDE\.md: references missing path `config\.ts`/);
  }],

  // SA-16: a substring hit such as "run-loop.ts" does not count as listing harness/loop.ts.
  ["SA-16 harness file only matched as a substring is reported", () => {
    const r = run({ "CLAUDE.md": BASE["CLAUDE.md"].replace(HARNESS, "Follow the run-loop.ts pattern.\n") });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /harness\/ description does not mention loop\.ts/);
  }],

  // SA-17: inline code paths in INSTRUCTIONS.md are checked too.
  ["SA-17 stale inline path in INSTRUCTIONS.md is reported", () => {
    const r = run({ "INSTRUCTIONS.md": "# INSTRUCTIONS\n\nThe turn loop is `src/harness/old-loop.ts`.\n" });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /INSTRUCTIONS\.md: references missing path `src\/harness\/old-loop\.ts`/);
  }],

  // SA-18: a missing doc is a clean, counted failure, not an uncaught ENOENT stack.
  ["SA-18 missing README.md fails cleanly", () => {
    const r = run({ "README.md": null });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /check-docs: \d+ problem\(s\)/);
    assert.match(r.stderr, /README\.md: cannot read/);
    assert.doesNotMatch(r.stderr, /\n\s+at |ENOENT: no such file or directory, open/);
  }],

  // SA-21: `.js` references are checked (but a bare `.js` extension is not a path).
  ["SA-21 stale `.js` reference is reported", () => {
    const r = run({ "AGENTS.md": `${BASE["AGENTS.md"]}Helper: \`scripts/helper.js\`.\n` });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /AGENTS\.md: references missing path `scripts\/helper\.js`/);
    assert.doesNotMatch(r.stderr, /missing path `\.js`/);
  }],
];

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    process.stderr.write(`  ok   ${name}\n`);
  } catch (e) {
    failed++;
    process.stderr.write(`  FAIL ${name}\n${String(e?.message ?? e).replace(/^/gm, "       ")}\n`);
  }
}
process.stderr.write(failed ? `smoke-check-docs: ${failed}/${cases.length} failed\n` : `smoke-check-docs: ${cases.length} passed\n`);
process.exit(failed ? 1 : 0);
