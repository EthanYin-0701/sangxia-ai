import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { configHome } from "../../src/config-home.js";

const HOME = "/home/u";
const LEGACY = join(HOME, ".config", "sangxia");
const none = () => false;
const only = (...paths: string[]) => (p: string) => paths.includes(p);

describe("configHome (SA-59)", () => {
  it("defaults to ~/.config/sangxia on POSIX without XDG_CONFIG_HOME", () => {
    assert.equal(configHome({}, "linux", HOME, none), LEGACY);
    assert.equal(configHome({}, "darwin", HOME, none), LEGACY);
  });

  it("honors an absolute XDG_CONFIG_HOME and ignores a relative one", () => {
    assert.equal(configHome({ XDG_CONFIG_HOME: "/xdg" }, "linux", HOME, none), join("/xdg", "sangxia"));
    assert.equal(configHome({ XDG_CONFIG_HOME: "rel/xdg" }, "linux", HOME, none), LEGACY);
  });

  it("uses %APPDATA%\\sangxia on Windows and ignores XDG_CONFIG_HOME there", () => {
    const appData = "C:\\Users\\u\\AppData\\Roaming";
    assert.equal(configHome({ APPDATA: appData, XDG_CONFIG_HOME: "/xdg" }, "win32", HOME, none), join(appData, "sangxia"));
    assert.equal(configHome({}, "win32", HOME, none), LEGACY);
  });

  it("SANGXIA_HOME overrides everything", () => {
    assert.equal(configHome({ SANGXIA_HOME: "/opt/sx", XDG_CONFIG_HOME: "/xdg", APPDATA: "C:\\a" }, "win32", HOME, none), resolve("/opt/sx"));
  });

  it("keeps an existing legacy dir when the OS-convention dir doesn't exist yet", () => {
    const xdg = join("/xdg", "sangxia");
    assert.equal(configHome({ XDG_CONFIG_HOME: "/xdg" }, "linux", HOME, only(LEGACY)), LEGACY);
    assert.equal(configHome({ XDG_CONFIG_HOME: "/xdg" }, "linux", HOME, only(LEGACY, xdg)), xdg);
    const appData = join("C:", "Roaming");
    assert.equal(configHome({ APPDATA: appData }, "win32", HOME, only(LEGACY)), LEGACY);
  });
});
