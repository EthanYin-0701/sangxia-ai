import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ClientChannel } from "../../src/acp/client-channel.js";
import type { ToolContext } from "../../src/harness/tool.js";
import { Session } from "../../src/session.js";
import { discoverSkills, useSkillTool } from "../../src/skills/index.js";

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "sangxia-skills-"));
  const skillDir = join(root, "custom", "skill-home", "demo");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: d\n---\n运行 <技能目录>/scripts/demo.mjs\n");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("use_skill", () => {
  // SA-60: skills run from any `skills.dirs` location and on any OS shell, so the
  // model must be told where the skill lives instead of probing candidate paths
  // with a bash-only loop.
  it("reports the skill's absolute directory, including custom skills.dirs locations", async () => {
    const session = new Session("unit-skills", root, [], { readTextFile: false, writeTextFile: false, terminal: false }, "auto", "m");
    session.skills = await discoverSkills(root, ["custom/skill-home"]);
    const ctx: ToolContext = { conn: {} as ClientChannel, session, signal: new AbortController().signal, toolCallId: "t" };

    const r = await useSkillTool.run({ name: "demo" }, ctx);
    assert.ok(!r.isError, r.output);
    const lines = r.output.split("\n");
    assert.equal(lines[0], `技能目录: ${join(root, "custom", "skill-home", "demo")}`);
    assert.match(r.output, /运行 <技能目录>\/scripts\/demo\.mjs/);
  });
});
