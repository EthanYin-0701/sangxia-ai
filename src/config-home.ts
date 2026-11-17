import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { logger } from "./logger.js";

/**
 * User-level home for everything Sangxia keeps outside a project: `config.json`,
 * `sessions/`, `skills/`, `AGENTS.md`. Resolution:
 *
 *   1. `$SANGXIA_HOME` — one switch that relocates all of the above;
 *   2. the OS convention: `%APPDATA%\sangxia` on Windows, otherwise
 *      `$XDG_CONFIG_HOME/sangxia` (only an absolute value counts, per the XDG spec);
 *   3. `~/.config/sangxia` — the historical location and the fallback.
 *
 * Backward compatibility: when the OS-convention dir doesn't exist yet but the
 * legacy `~/.config/sangxia` does, keep using the legacy dir (and log a migration
 * hint once), so existing installs don't silently lose their config/sessions.
 *
 * Evaluated per call (not at module load) so tests and smoke scripts that swap
 * HOME/env at runtime see the current values.
 */
export function configHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
): string {
  if (env.SANGXIA_HOME) return resolve(env.SANGXIA_HOME);

  const legacy = join(home, ".config", "sangxia");
  let preferred = legacy;
  if (platform === "win32") {
    if (env.APPDATA) preferred = join(env.APPDATA, "sangxia");
  } else if (env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)) {
    preferred = join(env.XDG_CONFIG_HOME, "sangxia");
  }

  if (preferred !== legacy && !exists(preferred) && exists(legacy)) {
    if (!warnedLegacy) {
      warnedLegacy = true;
      logger.warn(`using legacy config dir ${legacy}; move it to ${preferred} (or set SANGXIA_HOME) to follow the OS convention`);
    }
    return legacy;
  }
  return preferred;
}

let warnedLegacy = false;
