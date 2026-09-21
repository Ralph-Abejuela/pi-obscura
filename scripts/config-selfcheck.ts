// The runnable check for feature 3 (plugin state and configuration, spec 0005).
// Proves the config logic that a live browser call cannot reach on its own:
// per key fallback on bad values, corrupt file handling, and the set form's
// refusal and rewrite rules. Everything runs against a throwaway config file
// in the OS temp folder, so your real ~/.pi/agent/obscura.json is never
// touched here. The stealth capability check also runs against the real
// installed binary when one exists, same as the spawn path uses.
//
// Run: node scripts/config-selfcheck.ts   (node 24 runs TypeScript directly)

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  type EngineConfig,
  loadConfig,
  parseConfig,
  setConfigValue,
  stealthSupport,
} from "../src/config.js";
import { findBinary } from "../src/engine.js";

function main() {
  // parseConfig: fallback per key, the warning names the key, valid values win.
  const messy = parseConfig({
    binaryPath: 42, // wrong type: falls back to absent
    stealth: "yes", // wrong type: falls back to false
    port: 99999, // out of range: falls back to absent
    connectTimeoutMs: -5, // not positive: falls back to default
    spawnTimeoutMs: "fast", // wrong type: falls back to default
    stopGraceMs: 5000, // valid
    profileDir: 42, // wrong type: falls back to the default path
    madeUpKey: true, // unknown: ignored with a note
  });
  assert.equal(messy.config.binaryPath, undefined, "binaryPath falls back to absent");
  assert.equal(messy.config.stealth, false, "stealth falls back to false");
  assert.equal(messy.config.port, undefined, "port falls back to absent");
  assert.equal(messy.config.connectTimeoutMs, 10_000, "bad timeout falls back to default");
  assert.equal(messy.config.spawnTimeoutMs, 30_000, "bad spawn timeout falls back to default");
  assert.equal(messy.config.stopGraceMs, 5000, "valid timeout survives");
  assert.equal(
    messy.config.profileDir,
    DEFAULT_CONFIG.profileDir,
    "a bad profileDir falls back to the default path, so cookies still persist",
  );
  const keysNamed = new Set(messy.issues.map((issue) => issue.key));
  for (const key of [
    "binaryPath",
    "stealth",
    "port",
    "connectTimeoutMs",
    "spawnTimeoutMs",
    "profileDir",
    "madeUpKey",
  ]) {
    assert.ok(keysNamed.has(key), `a warning names every offending key, including ${key}`);
  }

  const defaults: EngineConfig = {
    stealth: false,
    connectTimeoutMs: 10_000,
    spawnTimeoutMs: 30_000,
    stopGraceMs: 2_000,
    profileDir: DEFAULT_CONFIG.profileDir,
  };
  assert.deepEqual(DEFAULT_CONFIG, defaults, "the defaults match the spec table");
  assert.deepEqual(
    parseConfig({}),
    { config: defaults, issues: [] },
    "an empty file means defaults",
  );
  assert.equal(
    parseConfig("not an object").config.stealth,
    false,
    "a non object file falls back everywhere with a file issue",
  );
  assert.ok(
    parseConfig("not an object").issues.some((issue) => issue.key === "file"),
    "a non object file reports the file issue",
  );

  // The write path: a real file in a temp folder, pointed at by the path seam.
  const tempDir = mkdtempSync(join(tmpdir(), "obscura-config-check-"));
  const configPath = join(tempDir, "obscura.json");
  try {
    // Missing file: defaults, no issues.
    const missing = loadConfig(configPath);
    assert.deepEqual(missing.config, defaults, "a missing file means defaults");
    assert.equal(missing.issues.length, 0, "a missing file has no warnings");

    // Corrupt file: defaults plus one file warning, never a crash.
    writeFileSync(configPath, "{ not json", "utf8");
    const corrupt = loadConfig(configPath);
    assert.deepEqual(corrupt.config, defaults, "a corrupt file means defaults");
    assert.ok(
      corrupt.issues.some((issue) => issue.key === "file"),
      "a corrupt file warns",
    );

    // set refuses a wrong type and an out of range value, file unchanged.
    const refuse = (key: string, value: string): void => {
      const before = readFileSync(configPath, "utf8");
      const outcome = setConfigValue(key, value, configPath);
      assert.equal(outcome.ok, false, `${key} = ${value} is refused`);
      assert.equal(
        readFileSync(configPath, "utf8"),
        before,
        `${key} = ${value} leaves the file unchanged`,
      );
    };
    refuse("stealth", "maybe");
    refuse("port", "99999");
    refuse("port", "abc");
    refuse("spawnTimeoutMs", "");
    refuse("bogusKey", "1");

    // set on a corrupt file rewrites clean from the edit; the garbage drops.
    const rewritten = setConfigValue("stealth", "true", configPath);
    assert.equal(rewritten.ok, true, "set succeeds on a corrupt file");
    assert.equal(rewritten.garbageDropped, true, "the unreadable content is dropped");
    assert.equal(rewritten.after.config.stealth, true, "the edited value applies");
    assert.ok(JSON.parse(readFileSync(configPath, "utf8")), "the rewritten file parses");

    // set a value, then clear an override.
    const setPort = setConfigValue("port", "9333", configPath);
    assert.equal(setPort.ok, true, "a valid port is accepted");
    assert.equal(setPort.after.config.port, 9333, "the port pins after the set");
    const clearPort = setConfigValue("port", "", configPath);
    assert.equal(clearPort.ok, true, "an empty value clears the port override");
    assert.equal(clearPort.after.config.port, undefined, "the port override is gone");

    // spec 0008: profileDir is settable, trimmed, and can go back to the default.
    const setProfile = setConfigValue("profileDir", "  C:/tmp/probe profile  ", configPath);
    assert.equal(setProfile.ok, true, "a profileDir path is accepted");
    assert.equal(
      setProfile.after.config.profileDir,
      "C:/tmp/probe profile",
      "the path is trimmed, so a stray space cannot create a second directory",
    );
    const clearProfile = setConfigValue("profileDir", "", configPath);
    assert.equal(clearProfile.ok, true, "an empty value clears the profileDir override");
    assert.equal(
      clearProfile.after.config.profileDir,
      DEFAULT_CONFIG.profileDir,
      "clearing profileDir restores the default path, so cookies still persist",
    );

    // A hand edit with mixed values still validates per key on read.
    writeFileSync(configPath, JSON.stringify({ stealth: true, port: 70000 }, null, 2), "utf8");
    const handEdited = loadConfig(configPath);
    assert.equal(handEdited.config.stealth, true, "the valid hand edited value applies");
    assert.equal(handEdited.config.port, undefined, "the out of range hand edit falls back");
    assert.ok(
      handEdited.issues.some((issue) => issue.key === "port"),
      "the hand edit warns per key",
    );

    console.log("config validation self-check passed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main();

// AC-3, live: the capability check resolves a verdict for the real installed
// binary and names it, exactly like the spawn path and the view use it.
async function liveStealthCheck() {
  const binary = findBinary();
  if (!binary) {
    console.log("no engine binary installed; the live stealth check is skipped");
    return;
  }
  const verdict = await stealthSupport(binary);
  assert.ok(verdict.message.includes(binary), "the stealth verdict names the binary path");
  console.log(
    `stealth capability check against ${binary}: ${verdict.supported ? "supported" : "not supported"}`,
  );
}

liveStealthCheck().catch((error) => {
  console.error("self-check failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
