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
import {
  clearCookies,
  importCookies,
  listCookies,
  parseCookieExport,
  setCookie,
} from "../src/session.js";
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

    // AC-5: the parser refusals need no engine, so they run first and fast.
    const exportCookies = [
      { name: "a", value: "1", domain: ".import.test", path: "/" },
      { name: "b", value: "2", domain: ".import.test", secure: true },
    ];
    assert.equal(parseCookieExport(exportCookies).length, 2, "a bare list of cookies is accepted");
    assert.equal(
      parseCookieExport({ cookies: exportCookies }).length,
      2,
      "an object carrying a cookies list is accepted, so a browser or MCP storage export imports",
    );
    const refuse = (raw: unknown, expected: RegExp, what: string): void => {
      assert.throws(() => parseCookieExport(raw), expected, what);
    };
    refuse({ notCookies: [] }, /list of cookies/, "an object without a cookies list is refused");
    refuse([], /empty/, "an empty export is refused");
    refuse(
      [{ value: "1", domain: "x" }],
      /cookie 1 has no name/,
      "an entry with no name is refused",
    );
    refuse([{ name: "a", domain: "x" }], /has no value/, "an entry with no value is refused");
    refuse([{ name: "a", value: "1" }], /has no domain/, "an entry with no domain is refused");
    refuse(
      [exportCookies[0], { name: "bad" }],
      /cookie 2 .*has no value/,
      "the refusal names which entry is wrong and what it is missing",
    );
    refuse("not a cookie export", /list of cookies/, "a string export is refused, not ignored");

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

      // AC-3, AC-4: the cookie core. Its own domains, so a filtered clear cannot
      // interfere with the persistence case above.
      const secret = "sup3r-s3cret-session-value";
      const accepted = await engine.runExclusive(undefined, (h) =>
        setCookie(h, { name: "pi_list_check", value: secret, domain: ".list.test" }, undefined),
      );
      assert.equal(accepted, true, "the engine accepts a cookie and says so");
      await engine.runExclusive(undefined, (h) =>
        setCookie(
          h,
          { name: "pi_other_check", value: "other-value", domain: ".other.test" },
          undefined,
        ),
      );

      const all = await engine.runExclusive(undefined, (h) => listCookies(h, undefined, undefined));
      assert.ok(
        all.some((row) => row.name === "pi_list_check"),
        "a set cookie shows in the list by name",
      );
      assert.ok(!JSON.stringify(all).includes(secret), "no listed row carries the cookie value");
      assert.ok(
        all.every((row) => !("value" in row)),
        "a row has no value field at all, so a report cannot print one by accident",
      );
      assert.ok(
        all.every((row) => row.domain.length > 0 && row.path.length > 0),
        "a row says which domain and path the cookie belongs to",
      );

      const filtered = await engine.runExclusive(undefined, (h) =>
        listCookies(h, "list.test", undefined),
      );
      assert.equal(filtered.length, 1, "the domain filter narrows the list to the matching cookie");
      assert.equal(filtered[0]?.name, "pi_list_check", "the filter kept the right cookie");

      const cleared = await engine.runExclusive(undefined, (h) =>
        clearCookies(h, "list.test", undefined),
      );
      assert.equal(cleared, 1, "a filtered clear reports how many cookies went");
      const remaining = await engine.runExclusive(undefined, (h) =>
        listCookies(h, "list.test", undefined),
      );
      assert.equal(remaining.length, 0, "the cleared cookie is gone from the jar");
      const untouched = await engine.runExclusive(undefined, (h) =>
        listCookies(h, "other.test", undefined),
      );
      assert.equal(
        untouched.length,
        1,
        "a cookie for another domain is untouched by a filtered clear",
      );

      // AC-1, AC-5: an import lands, and a refused one leaves the jar untouched.
      const exportPath = join(workDir, "session-export.json");
      writeFileSync(
        exportPath,
        `${JSON.stringify({ cookies: [{ name: "pi_import_check", value: secret, domain: ".import.test" }] }, null, 2)}\n`,
        "utf8",
      );
      const report = await engine.runExclusive(undefined, (h) =>
        importCookies(h, exportPath, undefined),
      );
      assert.equal(report.imported, 1, "the import sets the cookie it was given");
      assert.equal(report.refused, 0, "nothing was refused when the export was good");
      const importedRows = await engine.runExclusive(undefined, (h) =>
        listCookies(h, "import.test", undefined),
      );
      assert.equal(importedRows.length, 1, "the imported cookie is in the jar for its domain");
      assert.equal(importedRows[0]?.name, "pi_import_check", "and it is the one that was imported");
      assert.ok(
        !JSON.stringify(importedRows).includes(secret),
        "the imported value is not echoed back in the listing",
      );

      const badPath = join(workDir, "session-export-bad.json");
      writeFileSync(
        badPath,
        `${JSON.stringify([{ name: "pi_half_check", value: "x", domain: ".failed.test" }, { name: "no-value" }], null, 2)}\n`,
        "utf8",
      );
      await assert.rejects(
        engine.runExclusive(undefined, (h) => importCookies(h, badPath, undefined)),
        /cookie 2 .*has no value/,
        "one bad entry refuses the whole import",
      );
      const untouchedAfterRefusal = await engine.runExclusive(undefined, (h) =>
        listCookies(h, "failed.test", undefined),
      );
      assert.equal(
        untouchedAfterRefusal.length,
        0,
        "the refused import wrote nothing, so the good entry in it did not land either",
      );
      await assert.rejects(
        engine.runExclusive(undefined, (h) =>
          importCookies(h, join(workDir, "does-not-exist.json"), undefined),
        ),
        /does not exist/,
        "a missing cookie file is refused in plain words",
      );

      console.log(
        "session state self-check passed: profile dir created, cookie survived a restart, list redacted, filtered clear, import lands, bad import refused whole",
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
