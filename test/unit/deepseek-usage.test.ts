import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../../skills/deepseek-usage/scripts/deepseek-usage.mjs", import.meta.url));

const LINES = [
  '2026-09-15 10:00:00.123 [info] LLM request end model=deepseek-chat elapsedMs=10 usage={"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_cache_hit_tokens":30,"prompt_cache_miss_tokens":70}',
  '2026-09-16 11:00:00.456 [info] LLM request end model=deepseek-reasoner elapsedMs=12 usage={"prompt_tokens":50,"completion_tokens":5,"total_tokens":55,"prompt_tokens_details":{"cached_tokens":10}}',
  "2026-09-16 11:05:00.000 [info] LLM request end model=deepseek-chat elapsedMs=8 usage=undefined",
];

async function usage(args: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "deepseek-usage-"));
  try {
    await writeFile(join(dir, "sangxia-acp.log"), LINES.join("\n") + "\n");
    const { stdout } = await run(process.execPath, [SCRIPT, "usage", "--log", dir, "--no-ide-logs", ...args]);
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const FIELDS = ["requests", "withUsage", "prompt", "completion", "reasoning", "total", "cacheHit", "cacheMiss"] as const;

describe("deepseek-usage usage", () => {
  it("--json totals equal the sum of byDate and byModel, including cache fields (SA-61)", async () => {
    const out = JSON.parse(await usage(["--json"])) as {
      totals: Record<string, unknown>;
      byDate: Record<string, number>[];
      byModel: Record<string, number>[];
    };
    assert.equal(out.totals.cacheHit, 40);
    assert.equal(out.totals.cacheMiss, 70);
    for (const field of FIELDS) {
      const byDate = out.byDate.reduce((sum, b) => sum + b[field]!, 0);
      const byModel = out.byModel.reduce((sum, b) => sum + b[field]!, 0);
      assert.equal(out.totals[field], byDate, `totals.${field} vs Σ byDate`);
      assert.equal(out.totals[field], byModel, `totals.${field} vs Σ byModel`);
    }
  });

  it("human-readable report prints the cache hit/miss lines (SA-61)", async () => {
    const out = await usage([]);
    assert.match(out, /其中缓存命中:\s+40 \(36\.4%\)/);
    assert.match(out, /其中缓存未命中:\s+70/);
  });
});
