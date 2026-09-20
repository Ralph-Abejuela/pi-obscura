// src/config.ts
// Plugin state and configuration (spec 0005): one JSON file at
// ~/.pi/agent/obscura.json holds the tunable settings. The file is re read at
// every engine start, so an edit applies at the next lifecycle moment without
// a reload, and a config change never needs a code change.
//
// Every value is validated per key: a missing file, a corrupt file, a wrong
// value type, or an out of range value falls back to that key's default with
// a plain warning that names the key and the fix, and a bad config can never
// crash the plugin (AC-5). Warnings are derived at each read and never
// persisted, so fixing the file clears them on the next read. The set path
// validates before writing, so /browser-config set and a hand edit behave
// the same (AC-6).
//
// The stealth capability check also lives here (AC-3): one `obscura --help`
// run per binary path per session, bounded by a 5 second timeout, its output
// scanned for the stealth flag. A failed or timed out run reads as not
// supported. The cache is module state, so a pi hot reload starts a fresh
// instance and naturally clears it.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "obscura.json");

export interface EngineConfig {
  /** Override the engine search order; absent means the search order applies. */
  binaryPath?: string;
  /** Pass --stealth on spawn when true, gated by the capability check (AC-3). */
  stealth: boolean;
  /** Pin the engine port; absent means a free loopback port is picked at each start. */
  port?: number;
  /** How long the endpoint wait tolerates before a spawn fails. */
  connectTimeoutMs: number;
  /** Bound on the whole spawn and CDP connect. */
  spawnTimeoutMs: number;
  /** Grace before a hard kill when stopping the engine. */
  stopGraceMs: number;
}

export interface ConfigIssue {
  /** The setting name, or "file" for a problem with the file itself. */
  key: string;
  /** Plain wording: what is wrong and how to fix it. */
  message: string;
}

export interface LoadedConfig {
  config: EngineConfig;
  issues: ConfigIssue[];
}

export const DEFAULT_CONFIG: EngineConfig = {
  stealth: false,
  connectTimeoutMs: 10_000,
  spawnTimeoutMs: 30_000,
  stopGraceMs: 2_000,
};

type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

function numberInRange(
  min: number,
  max: number,
  reason: string,
): (raw: unknown) => Verdict<number> {
  return (raw) => {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
      return { ok: false, reason };
    }
    return { ok: true, value: raw };
  };
}

const PORT: (raw: unknown) => Verdict<number> = numberInRange(
  1,
  65535,
  "must be a whole number between 1 and 65535",
);
const TIMEOUT: (raw: unknown) => Verdict<number> = numberInRange(
  1,
  Number.MAX_SAFE_INTEGER,
  "must be a positive whole number",
);
const BOOLEAN: (raw: unknown) => Verdict<boolean> = (raw) =>
  typeof raw === "boolean"
    ? { ok: true, value: raw }
    : { ok: false, reason: "must be true or false" };
const TEXT: (raw: unknown) => Verdict<string> = (raw) =>
  typeof raw === "string" ? { ok: true, value: raw } : { ok: false, reason: "must be text" };

const KNOWN_KEYS = [
  "binaryPath",
  "stealth",
  "port",
  "connectTimeoutMs",
  "spawnTimeoutMs",
  "stopGraceMs",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate one parsed file into the effective values, falling back per key. */
export function parseConfig(raw: unknown): LoadedConfig {
  const config: EngineConfig = { ...DEFAULT_CONFIG };
  const issues: ConfigIssue[] = [];
  if (!isRecord(raw)) {
    issues.push({
      key: "file",
      message:
        "the file must hold a single JSON object of settings, so every setting falls back to its default",
    });
    return { config, issues };
  }
  for (const key of Object.keys(raw)) {
    switch (key) {
      case "binaryPath": {
        const verdict = TEXT(raw[key]);
        if (verdict.ok) config.binaryPath = verdict.value;
        else
          issues.push({
            key,
            message: `binaryPath ${verdict.reason}; using the search order instead`,
          });
        break;
      }
      case "stealth": {
        const verdict = BOOLEAN(raw[key]);
        if (verdict.ok) config.stealth = verdict.value;
        else issues.push({ key, message: `stealth ${verdict.reason}; using off` });
        break;
      }
      case "port": {
        const verdict = PORT(raw[key]);
        if (verdict.ok) config.port = verdict.value;
        else
          issues.push({ key, message: `port ${verdict.reason}; using a free port at each start` });
        break;
      }
      case "connectTimeoutMs":
      case "spawnTimeoutMs":
      case "stopGraceMs": {
        const verdict = TIMEOUT(raw[key]);
        if (verdict.ok) config[key] = verdict.value;
        else issues.push({ key, message: `${key} ${verdict.reason}; using the default value` });
        break;
      }
      default:
        issues.push({
          key,
          message: `unknown setting "${key}"; it is ignored. Known settings: ${KNOWN_KEYS.join(", ")}`,
        });
    }
  }
  return { config, issues };
}

/** The config file's effective values: the file when present, defaults otherwise. */
export function loadConfig(path = CONFIG_PATH): LoadedConfig {
  if (!existsSync(path)) return { config: { ...DEFAULT_CONFIG }, issues: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "it is not valid JSON";
    return {
      config: { ...DEFAULT_CONFIG },
      issues: [
        {
          key: "file",
          message: `the config file could not be read (${detail}); using the default for every setting. Fix the file, or rewrite it with /browser-config set`,
        },
      ],
    };
  }
  return parseConfig(raw);
}

/** The raw file content, told apart from a missing file and an unreadable one. */
export function readRawConfig(
  path = CONFIG_PATH,
):
  | { kind: "missing" }
  | { kind: "readable"; record: Record<string, unknown> }
  | { kind: "unreadable" } {
  if (!existsSync(path)) return { kind: "missing" };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? { kind: "readable", record: parsed } : { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
  }
}

export function writeConfig(record: Record<string, unknown>, path = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export interface StealthVerdict {
  supported: boolean;
  /** Plain wording with the next step; the view and the probe show it verbatim. */
  message: string;
}

const STEALTH_CHECK_TIMEOUT_MS = 5_000;

// One check per binary path per session (AC-3): a pi hot reload starts a
// fresh module instance, so this map is naturally cleared by a reload.
const stealthCache = new Map<string, Promise<StealthVerdict>>();

function stealthNotSupported(detail: string): StealthVerdict {
  return {
    supported: false,
    message: `the binary does not accept --stealth (${detail}). It starts without stealth; install a build with the stealth feature to use it`,
  };
}

function runStealthCheck(binaryPath: string): Promise<StealthVerdict> {
  return new Promise<StealthVerdict>((resolve) => {
    const child = spawn(binaryPath, ["--help"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(stealthNotSupported("--help did not answer within 5 seconds"));
    }, STEALTH_CHECK_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
    };
    const settle = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      if (/\bstealth\b/i.test(output)) {
        resolve({ supported: true, message: `the binary at ${binaryPath} accepts --stealth` });
      } else {
        resolve(stealthNotSupported("its --help output has no stealth flag"));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve(stealthNotSupported(error.message));
    });
    child.on("exit", settle);
  });
}

export function stealthSupport(binaryPath: string): Promise<StealthVerdict> {
  const cached = stealthCache.get(binaryPath);
  if (cached) return cached;
  const check = runStealthCheck(binaryPath);
  stealthCache.set(binaryPath, check);
  return check;
}

type Edit =
  | { ok: true; changed: string; apply: (record: Record<string, unknown>) => void }
  | { ok: false; message: string };

// The set form of /browser-config (AC-6): the typed value is parsed with the
// key's expected type, and anything that cannot parse is refused. An empty
// value clears the binaryPath or port override; the keys with a default need
// a real value.
function parseEdit(key: string, rawValue: string): Edit {
  if (key === "binaryPath") {
    if (rawValue.trim() === "") {
      return {
        ok: true,
        changed: "binaryPath cleared; the engine search order applies",
        apply: (r) => delete r.binaryPath,
      };
    }
    return {
      ok: true,
      changed: `binaryPath set to ${rawValue}`,
      apply: (r) => {
        r.binaryPath = rawValue;
      },
    };
  }
  if (key === "port") {
    if (rawValue.trim() === "") {
      return {
        ok: true,
        changed: "port cleared; a free port is picked at each start",
        apply: (r) => delete r.port,
      };
    }
    if (!/^\d+$/.test(rawValue.trim())) {
      return { ok: false, message: "port must be a whole number between 1 and 65535" };
    }
    const port = Number(rawValue.trim());
    if (port < 1 || port > 65535) {
      return { ok: false, message: "port must be a whole number between 1 and 65535" };
    }
    return {
      ok: true,
      changed: `port set to ${port}`,
      apply: (r) => {
        r.port = port;
      },
    };
  }
  if (key === "stealth") {
    const value = rawValue.trim().toLowerCase();
    if (value !== "true" && value !== "false") {
      return { ok: false, message: "stealth must be true or false" };
    }
    return {
      ok: true,
      changed: `stealth set to ${value}`,
      apply: (r) => {
        r.stealth = value === "true";
      },
    };
  }
  if (key === "connectTimeoutMs" || key === "spawnTimeoutMs" || key === "stopGraceMs") {
    if (!/^\d+$/.test(rawValue.trim()) || Number(rawValue.trim()) < 1) {
      return { ok: false, message: `${key} must be a positive whole number of milliseconds` };
    }
    const value = Number(rawValue.trim());
    return {
      ok: true,
      changed: `${key} set to ${value}`,
      apply: (r) => {
        r[key] = value;
      },
    };
  }
  return {
    ok: false,
    message: `unknown setting "${key}". Known settings: ${KNOWN_KEYS.join(", ")}`,
  };
}

export type SetOutcome =
  | {
      ok: true;
      /** Plain report of the change, for the command to show. */
      changed: string;
      /** The file did not parse as JSON, so it was rewritten from this edit alone. */
      garbageDropped: boolean;
      /** The effective config and warnings after the write. */
      after: LoadedConfig;
    }
  | { ok: false; message: string };

/** Validate and write one setting. On a refuse or a write failure nothing changes. */
export function setConfigValue(key: string, rawValue: string, path = CONFIG_PATH): SetOutcome {
  const edit = parseEdit(key, rawValue);
  if (!edit.ok) return { ok: false, message: edit.message };

  let record: Record<string, unknown>;
  let garbageDropped = false;
  const raw = readRawConfig(path);
  if (raw.kind === "readable") {
    record = { ...raw.record };
  } else {
    garbageDropped = raw.kind === "unreadable";
    record = {};
  }
  edit.apply(record);
  try {
    writeConfig(record, path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "a disk write error";
    return {
      ok: false,
      message: `the config file could not be written (${detail}); nothing changed`,
    };
  }
  return { ok: true, changed: edit.changed, garbageDropped, after: loadConfig(path) };
}
