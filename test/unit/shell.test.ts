import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectDangerousCommand } from "../../src/tools/scope.js";
import { resolveShell, shellSyntaxHint } from "../../src/tools/shell.js";

describe("resolveShell", () => {
  for (const platform of ["linux", "darwin"] as const) {
    it(`uses bash -lc on ${platform}`, () => {
      const spec = resolveShell(platform);
      assert.equal(spec.kind, "bash");
      assert.equal(spec.command, "bash");
      assert.deepEqual(spec.args("echo $HOME"), ["-lc", "echo $HOME"]);
      assert.match(shellSyntaxHint(spec), /export/);
    });
  }

  it("uses PowerShell on win32 with UTF-8 prelude and process-scoped Bypass", () => {
    const spec = resolveShell("win32");
    assert.equal(spec.kind, "powershell");
    assert.equal(spec.command, "powershell.exe");
    const args = spec.args("echo $env:PATH");
    const i = args.indexOf("-Command");
    assert.ok(i >= 0 && i === args.length - 2, "-Command must be followed only by the script");
    assert.ok(args.includes("-NoProfile") && args.includes("-NonInteractive"));
    assert.equal(args[args.indexOf("-ExecutionPolicy") + 1], "Bypass");
    const script = args.at(-1)!;
    assert.match(script, /OutputEncoding/);
    assert.ok(script.endsWith("echo $env:PATH"));
    assert.match(shellSyntaxHint(spec), /\$env:/);
  });
});

describe("detectDangerousCommand (PowerShell)", () => {
  it("flags recursive forced Remove-Item and aliases, case-insensitively", () => {
    assert.ok(detectDangerousCommand("Remove-Item -Recurse -Force .\\build"));
    assert.ok(detectDangerousCommand("rm -r -fo C:\\proj"));
    assert.ok(detectDangerousCommand("REMOVE-ITEM -recurse -force x"));
    assert.ok(detectDangerousCommand("rd -Recurse C:\\"));
    assert.ok(detectDangerousCommand("del -Recurse $env:USERPROFILE"));
  });

  it("flags disk/system cmdlets", () => {
    assert.ok(detectDangerousCommand("Format-Volume -DriveLetter D"));
    assert.ok(detectDangerousCommand("Stop-Computer"));
  });

  it("leaves ordinary PowerShell commands alone", () => {
    assert.equal(detectDangerousCommand("Remove-Item .\\tmp.txt"), undefined);
    assert.equal(detectDangerousCommand("Remove-Item -Recurse .\\dist"), undefined);
    assert.equal(detectDangerousCommand("Get-ChildItem -Recurse -Force"), undefined);
    assert.equal(detectDangerousCommand("npm test"), undefined);
  });
});
