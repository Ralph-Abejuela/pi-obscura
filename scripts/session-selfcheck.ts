// The runnable check for feature 9 (session state, spec 0008). This first slice
// covers the profile directory: the plugin creates the directory the setting
// points at, spawns the engine with it, and a cookie set over CDP in one engine
// process is in the jar of the next one (AC-2, AC-6).
//
// The supervisor reads the plugin's real config path, so this check writes a
// temporary profileDir into ~/.pi/agent/obscura.json and puts the file back,
// byte for byte, in a finally block. Nothing else in the config is touched.
//
// Run: node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs scripts/session-selfcheck.ts

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { send } from "../src/browser.js";
import { CONFIG_PATH } from "../src/config.js";
import { createEngineSupervisor } from "../src/supervisor.js";

const hadConfig = existsSync(CONFIG_PATH);
const configBefore = hadConfig ? readFileSync(CONFIG_PATH, "utf8") : "";

function restoreConfig(): void {
  if (hadConfig) writeFileSync(CONFIG_PATH, configBefore);
  else rmSync(CONFIG_PATH, { force: true });
}

function countCookies(response: unknown, name: string): number {
  const cookies = (response as { cookies?: Array<{ name?: string }> } | undefined)?.cookies ?? [];
  return cookies.filter((cookie) => cookie.name === name).length;
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), "obscura-session-check-"));
  const profileDir = join(workDir, "profile");
  try {
    assert.equal(existsSync(profileDir), false, "the profile directory starts absent");
    writeFileSync(CONFIG_PATH, `${JSON.stringify({ profileDir }, null, 2)}\n`, "utf8");

    const engine = createEngineSupervisor();
    try {
      const handle = await engine.ensureEngine(undefined);
      const spawnLine = handle.child.spawnargs.join(" ");
      assert.ok(spawnLine.includes("--storage-dir"), "the engine is spawned with --storage-dir");
      assert.ok(
        spawnLine.includes(profileDir),
        "the storage directory it gets is the configured profile directory",
      );
      assert.ok(existsSync(profileDir), "the plugin created the profile directory itself");

      await engine.runExclusive(undefined, (h) =>
        send(h, "Network.setCookie", {
          name: "pi_session_check",
          value: "written-over-cdp",
          domain: ".example.com",
          path: "/",
        }),
      );
      const firstJar = await engine.runExclusive(undefined, (h) =>
        send(h, "Network.getAllCookies", {}),
      );
      assert.equal(
        countCookies(firstJar, "pi_session_check"),
        1,
        "the cookie is in the jar of the first engine run",
      );

      // A second engine process on the same profile directory.
      await engine.stopEngine();
      await engine.ensureEngine(undefined);
      const secondJar = await engine.runExclusive(undefined, (h) =>
        send(h, "Network.getAllCookies", {}),
      );
      assert.equal(
        countCookies(secondJar, "pi_session_check"),
        1,
        "the cookie is still in the jar after a full engine restart",
      );
      assert.ok(
        existsSync(join(profileDir, "cookies.json")),
        "the engine wrote its cookie jar inside the profile directory",
      );

      console.log(
        "session state self-check passed: the profile directory is created, the engine gets it, and a cookie survives a restart",
      );
    } finally {
      await engine.stopEngine();
    }
  } finally {
    restoreConfig();
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("self-check failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
