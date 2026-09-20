// src/supervisor.ts
// The persistent engine supervisor (spec 0003, server lifecycle): one Obscura
// engine per extension instance, spawned lazily on the first browser tool
// call, reused across calls, and stopped cleanly on session shutdown or
// reload. Death is detected through the child exit event and the CDP
// WebSocket close; the call whose CDP work hit the dead engine fails in plain
// words, and the next browser call respawns without user action. The probe
// path in engine.ts stays untouched: feature 4 uses it to verify an install.
//
// State lives in the closure of createEngineSupervisor, one instance per
// extension load, so a pi hot reload starts a fresh state machine: the broken
// marker and the engine itself clear on reload (AC-5, AC-7).
//
// Feature 3 (spec 0005) feeds the config in here: the file at
// ~/.pi/agent/obscura.json is re read at every engine start, the spawn line
// is built from the effective values (an explicit port, --stealth when the
// binary supports it), and the timeouts come from the same read.

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
import CDP from "chrome-remote-interface";
import {
  CONFIG_PATH,
  type ConfigIssue,
  type EngineConfig,
  type LoadedConfig,
  loadConfig,
  type StealthVerdict,
  stealthSupport,
} from "./config.js";
import { findBinary, probeDomains, waitForEndpoint, withTimeout } from "./engine.js";

// The engine process: stdin closed, stdout and stderr piped for endpoint detection.
type EngineProcess = ChildProcessByStdio<null, Readable, Readable>;

export type EnginePhase = "stopped" | "starting" | "ready" | "dead";

export interface EngineHandle {
  child: EngineProcess;
  client: CDP.Client;
  sessionId?: string;
  endpoint: string;
  binaryPath: string;
}

export interface EngineSnapshot {
  phase: EnginePhase;
  binaryPath?: string;
  endpoint?: string;
  supportedDomains: string[];
  unsupportedDomains: string[];
  consecutiveFailures: number;
  broken: boolean;
  /** The config file path, for reporting where the settings live. */
  configPath: string;
  /** The effective values the running engine was spawned with (defaults before any spawn). */
  config: EngineConfig;
  /** Per key fallback warnings from the last config read. */
  configIssues: ConfigIssue[];
  /** The stealth capability verdict from the last spawn, when stealth was on. */
  stealthVerdict?: StealthVerdict;
}

export interface EngineSupervisor {
  /** Spawn on first use, reuse when ready, share one in flight spawn, fail fast when broken. */
  ensureEngine(signal?: AbortSignal): Promise<EngineHandle>;
  /** Serialize every browser operation through one queue (spec 0001 contract). */
  runExclusive<T>(
    signal: AbortSignal | undefined,
    fn: (handle: EngineHandle) => Promise<T>,
  ): Promise<T>;
  /** Grace then hard kill; idempotent. Runs on session shutdown and reload. */
  stopEngine(): Promise<void>;
  /** The status line value: not started | starting | ready | down. */
  statusText(): string;
  /** A copy of the supervisor state for reports. */
  snapshot(): EngineSnapshot;
  /** Attach the status line writer; applies the current state immediately. */
  bindStatus(sink: (text: string) => void): void;
}

const NOT_INSTALLED_MESSAGE =
  "The engine is not installed. Run /browser-install, or ask the agent to call browser_install.";
const BROKEN_MESSAGE =
  "The engine failed to start twice in a row and is marked broken. Reload the plugin (/reload) " +
  "or restart pi, then call again.";
const CANCELLED_MESSAGE = "the browser call was cancelled";
// AC-2: a spawn failure whose detail matches a busy bind gets the stale port hint.
const STALE_PORT_PATTERN =
  /address already in use|already in use|EADDRINUSE|failed to bind|could not bind|bind.*error|port.*in use/i;

// A raw protocol send; the engine's actual coverage is the thing under test,
// so we probe by method name (same cast engine.ts explains).
type SendRaw = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;

interface EngineState {
  phase: EnginePhase;
  child: EngineProcess | null;
  client: CDP.Client | null;
  sessionId?: string;
  endpoint?: string;
  binaryPath?: string;
  supportedDomains: string[];
  unsupportedDomains: string[];
  consecutiveFailures: number;
  startingPromise: Promise<EngineHandle> | null;
  /** The config read that fed the current or last spawn. */
  lastConfig: LoadedConfig | null;
  /** The stealth capability verdict from the last spawn, when stealth was on. */
  stealthVerdict: StealthVerdict | null;
}

function freshState(): EngineState {
  return {
    phase: "stopped",
    child: null,
    client: null,
    sessionId: undefined,
    endpoint: undefined,
    binaryPath: undefined,
    supportedDomains: [],
    unsupportedDomains: [],
    consecutiveFailures: 0,
    startingPromise: null,
    lastConfig: null,
    stealthVerdict: null,
  };
}

function abortPromise(signal?: AbortSignal): Promise<never> | null {
  if (!signal) return null;
  if (signal.aborted) return Promise.reject(new Error(CANCELLED_MESSAGE));
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error(CANCELLED_MESSAGE)), { once: true });
  });
}

// The caller's abort cancels only its own await; the shared spawn is not tied
// to any one caller, so queued calls keep riding the same engine start.
function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return Promise.race([promise, abortPromise(signal) as Promise<never>]);
}

// AC-2: a spawn failure names the attempted port and binary path, and a busy
// bind gets the stale port hint. The hint adapts to whether the port came
// from the config pin or the free pick.
function spawnError(error: unknown, binaryPath: string, port: number, portPinned: boolean): Error {
  const detail = error instanceof Error ? error.message : "the engine failed to start";
  const hint = STALE_PORT_PATTERN.test(detail)
    ? portPinned
      ? ` The config pins port ${port} (the "port" setting in ${CONFIG_PATH}). Another process may ` +
        "hold it; free the port, or clear the pin with /browser-config set port. This plugin never " +
        "kills a process it did not spawn."
      : ` It was trying the free port ${port}. A process from an earlier session may still hold ` +
        "it. Check what is listening (netstat -ano on Windows, lsof -i elsewhere) and stop it by " +
        "hand; this plugin never kills a process it did not spawn."
    : "";
  return new Error(
    `The engine could not start on port ${port} with the binary at ${binaryPath}: ${detail}.${hint}`,
  );
}

// Pick a free loopback port by binding 127.0.0.1:0, then release it for the
// engine to claim (AC-2). The pick and the engine bind have a tiny race, which
// the spec accepts: nothing else binds loopback ports in practice.
function freeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function isNotInstalled(error: unknown): boolean {
  return error instanceof Error && error.message === NOT_INSTALLED_MESSAGE;
}

function waitForExit(child: EngineProcess, ms: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function createEngineSupervisor(): EngineSupervisor {
  const state = freshState();
  let statusSink: ((text: string) => void) | null = null;
  // The shared operation queue (spec 0001): every browser tool runs through
  // runExclusive so CDP work never interleaves. The tail swallows failures so
  // one failed call never wedges the queue.
  let queueTail: Promise<unknown> = Promise.resolve();

  const statusTextOf = (): string => {
    switch (state.phase) {
      case "starting":
        return "starting";
      case "ready":
        return "ready";
      case "dead":
        return "down";
      default:
        return "not started";
    }
  };
  const applyStatus = (): void => {
    statusSink?.(statusTextOf());
  };

  const snapshot = (): EngineSnapshot => {
    // Before any spawn the last config read does not exist yet; read the file
    // live then, so warnings about a broken file still surface. After a spawn
    // the report shows the values the engine actually got.
    const loaded = state.lastConfig ?? loadConfig();
    return {
      phase: state.phase,
      binaryPath: state.binaryPath,
      endpoint: state.endpoint,
      supportedDomains: [...state.supportedDomains],
      unsupportedDomains: [...state.unsupportedDomains],
      consecutiveFailures: state.consecutiveFailures,
      broken: state.phase === "dead" && state.consecutiveFailures >= 2,
      configPath: CONFIG_PATH,
      config: loaded.config,
      configIssues: loaded.issues,
      stealthVerdict: state.stealthVerdict ?? undefined,
    };
  };

  const bindStatus = (sink: (text: string) => void): void => {
    statusSink = sink;
    applyStatus();
  };

  // AC-3: the runtime death verdict, triggered by the exit event or the CDP
  // socket close. A death after ready is a normal event: it does not count
  // against the spawn counter (AC-5 counts only failed starts).
  const markDead = (): void => {
    if (state.phase !== "ready") return;
    state.phase = "dead";
    state.child = null;
    state.client = null;
    applyStatus();
  };

  const handleOf = (): EngineHandle => ({
    child: state.child as EngineProcess,
    client: state.client as CDP.Client,
    sessionId: state.sessionId,
    endpoint: state.endpoint as string,
    binaryPath: state.binaryPath as string,
  });

  // Spawn once and connect, mutating state as it goes. On failure it owns its
  // own cleanup: kills its child, closes its client, and nulls its own state
  // refs (identity guarded, so a later attempt or a stop is never touched).
  async function startEngine(): Promise<EngineHandle> {
    // AC-1: the config file is re read at every engine start. The read cannot
    // throw (per key fallback), so the spawn always has valid effective values.
    const loaded = loadConfig();
    state.lastConfig = loaded;
    const cfg = loaded.config;
    // The binaryPath override is checked first, then the search order (AC-1).
    const binaryPath = cfg.binaryPath ?? findBinary();
    if (!binaryPath) throw new Error(NOT_INSTALLED_MESSAGE);
    if (cfg.binaryPath !== undefined && !existsSync(binaryPath)) {
      throw new Error(
        `The binaryPath setting in ${CONFIG_PATH} points at ${binaryPath}, which does not exist. ` +
          "Fix the path in the file, or clear the setting with /browser-config set binaryPath.",
      );
    }

    // AC-2: spawn on an explicit port, the config pin or a free loopback pick.
    const port = cfg.port ?? (await freeLoopbackPort());
    // AC-3: stealth is gated by a per session capability check; a binary
    // without support still spawns, without the flag.
    let stealthVerdict: StealthVerdict | undefined;
    if (cfg.stealth) {
      stealthVerdict = await stealthSupport(binaryPath);
    }
    state.stealthVerdict = stealthVerdict ?? null;
    const args = [
      "serve",
      "--port",
      String(port),
      ...(stealthVerdict?.supported ? ["--stealth"] : []),
    ];

    const child = spawn(binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    state.child = child;
    state.binaryPath = binaryPath;

    // Runtime death via the process exiting (AC-3).
    const onExit = (): void => {
      if (state.phase === "ready" && state.child === child) markDead();
    };
    child.on("exit", onExit);

    // Spawn failures (wrong path, blocked) surface through the error event.
    const spawnFailed = new Promise<never>((_resolve, reject) => {
      child.once("error", (error) =>
        reject(new Error(`I could not start the engine: ${error.message}`)),
      );
    });

    let client: CDP.Client | undefined;
    let sessionId: string | undefined;
    try {
      const endpoint = (await Promise.race(
        [spawnFailed, waitForEndpoint(child, cfg.connectTimeoutMs)].filter(
          Boolean,
        ) as Promise<unknown>[],
      )) as string;
      if (state.phase !== "starting")
        throw new Error("the engine was stopped while it was starting");

      const connectPromise = CDP({ target: endpoint, local: true }).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : "the connection failed";
        throw new Error(`I could not open a CDP connection to the engine: ${detail}`);
      });
      client = (await withTimeout(
        connectPromise,
        cfg.spawnTimeoutMs,
        "engine start",
      )) as CDP.Client;
      if (state.phase !== "starting")
        throw new Error("the engine was stopped while it was starting");
      state.client = client;

      // Runtime death via the CDP socket closing (AC-3), same verdict.
      client.on("disconnect", () => {
        if (state.phase === "ready" && state.client === client) markDead();
      });

      // Capability probe at connect (spec 0001): attach the single page target
      // the tools operate on. Obscura lists no page target until one exists
      // (verified live on 0.2.2), so the plugin creates the one session page
      // with Target.createTarget and attaches to it. Engines that already
      // expose a page target (or connect straight to a page session) take
      // their existing path.
      try {
        // SAFETY: same raw send cast engine.ts documents.
        const sendRaw = client.send.bind(client) as unknown as SendRaw;
        const targets = (await sendRaw("Target.getTargets")) as
          | { targetInfos?: Array<{ targetId: string; type: string }> }
          | undefined;
        let targetId = (targets?.targetInfos ?? []).find((t) => t.type === "page")?.targetId;
        if (!targetId) {
          const created = (await sendRaw("Target.createTarget", {
            url: "about:blank",
          })) as { targetId?: string } | undefined;
          targetId = created?.targetId;
        }
        if (targetId) {
          const attached = (await sendRaw("Target.attachToTarget", {
            targetId,
            flatten: true,
          })) as { sessionId?: string } | undefined;
          sessionId = attached?.sessionId;
        }
      } catch {
        // No browser level Target domain; the connected session is the page.
      }
      const { supported, unsupported } = await withTimeout(
        probeDomains(client, sessionId),
        cfg.spawnTimeoutMs,
        "engine start",
      );
      if (state.phase !== "starting")
        throw new Error("the engine was stopped while it was starting");

      state.sessionId = sessionId;
      state.endpoint = endpoint;
      state.supportedDomains = supported;
      state.unsupportedDomains = unsupported;
      return { child, client, sessionId, endpoint, binaryPath };
    } catch (error) {
      // Own this attempt's resources; nothing it started may outlive it.
      if (client) client.close().catch(() => {});
      if (child.exitCode === null) child.kill();
      if (state.child === child) state.child = null;
      if (state.client === client) state.client = null;
      throw spawnError(error, binaryPath, port, cfg.port !== undefined);
    }
  }

  async function ensureEngine(signal?: AbortSignal): Promise<EngineHandle> {
    // Ready: reuse the running engine (AC-1, same engine across calls).
    if (state.phase === "ready" && state.child && state.client) {
      return raceWithAbort(Promise.resolve(handleOf()), signal);
    }
    // A spawn is in flight: queued calls share it, never a second one (AC-4).
    if (state.phase === "starting" && state.startingPromise) {
      return raceWithAbort(state.startingPromise, signal);
    }
    // Broken after two failed starts: fail fast, no endpoint wait (AC-5).
    if (state.phase === "dead" && state.consecutiveFailures >= 2) {
      throw new Error(BROKEN_MESSAGE);
    }
    // stopped, or dead with fewer than two failures: (re)spawn now.
    state.phase = "starting";
    applyStatus();
    state.startingPromise = startEngine()
      .then((handle) => {
        if (state.child !== handle.child) {
          // A stop or a newer attempt owns the session; abandon this late start.
          handle.client.close().catch(() => {});
          if (handle.child.exitCode === null) handle.child.kill();
          return handle;
        }
        state.phase = "ready";
        state.consecutiveFailures = 0; // a successful start clears the counter (AC-5)
        applyStatus();
        return handle;
      })
      .catch((error: unknown) => {
        if (state.phase === "starting") {
          if (isNotInstalled(error)) {
            state.phase = "stopped"; // nothing spawned; the next call retries the same message
          } else {
            state.consecutiveFailures += 1;
            state.phase = "dead";
          }
          applyStatus();
        }
        throw error;
      })
      .finally(() => {
        state.startingPromise = null;
      });
    return raceWithAbort(state.startingPromise, signal);
  }

  async function stopEngine(): Promise<void> {
    const child = state.child;
    const client = state.client;
    // Flip first so death listeners and late commits no-op.
    state.phase = "stopped";
    state.child = null;
    state.client = null;
    state.startingPromise = null;
    state.lastConfig = null;
    state.stealthVerdict = null;
    applyStatus();
    if (client) client.close().catch(() => {});
    if (child && child.exitCode === null) {
      // The grace comes from the config read fresh at stop; a corrupt file
      // falls back to the default, per key, so this cannot throw.
      const graceMs = loadConfig().config.stopGraceMs;
      child.kill(); // grace
      await waitForExit(child, graceMs);
      if (child.exitCode === null) child.kill("SIGKILL"); // hard kill
    }
  }

  function runExclusive<T>(
    signal: AbortSignal | undefined,
    fn: (handle: EngineHandle) => Promise<T>,
  ): Promise<T> {
    const run = queueTail.then(async () => {
      const handle = await ensureEngine(signal);
      return fn(handle);
    });
    queueTail = run.catch(() => {});
    return run;
  }

  return {
    ensureEngine,
    runExclusive,
    stopEngine,
    statusText: statusTextOf,
    snapshot,
    bindStatus,
  };
}
