// src/engine.ts
// The thin engine probe for the stack and architecture scaffold.
// It finds the Obscura binary, starts a serve instance, opens a CDP connection,
// and reports which protocol domains the engine actually implements. Later
// features thicken each seam: feature 4 owns installing a missing binary,
// feature 5 replaces the spawn per probe with one persistent engine per session.
// ponytail: every probe spawns its own engine process and tears it down after;
// swap this for a persistent engine in feature 5 (server lifecycle).

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import CDP from "chrome-remote-interface";

// The engine process: stdin closed, stdout and stderr piped for endpoint detection.
type EngineProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface ProbeResult {
  message: string;
  binaryFound: boolean;
  binaryPath?: string;
  connected: boolean;
  supportedDomains: string[];
  unsupportedDomains: string[];
}

export interface ProbeOptions {
  signal?: AbortSignal;
  endpointTimeoutMs?: number;
}

const REQUIRED_DOMAINS = ["Page", "DOM", "DOMSnapshot", "Runtime"] as const;

// A raw protocol send: we probe by method name because the engine's actual
// coverage is the thing under test, not a fixed protocol surface.
type SendRaw = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>;

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Where the binary helper installs the engine (spec 0002). The probe reads it,
// the installer writes it, so it lives here and the import stays one way.
export const BIN_DIR = join(homedir(), ".pi", "agent", "bin");

function findBinary(): string | undefined {
  const names = process.platform === "win32" ? ["obscura.exe", "obscura"] : ["obscura"];
  // The installer's destination is checked first (spec 0002 follow-up).
  const dirs = [BIN_DIR];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir) dirs.push(dir);
  }
  // Common install folders the PATH may not cover.
  dirs.push(join(homedir(), ".cargo", "bin"));
  dirs.push(join(homedir(), ".local", "bin"));
  dirs.push(join(PACKAGE_ROOT, "target", "release")); // a local source build lives here
  dirs.push(join(PACKAGE_ROOT, "bin"));
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("the probe was cancelled");
}

function abortPromise(signal?: AbortSignal): Promise<never> | null {
  if (!signal) return null;
  if (signal.aborted) return Promise.reject(new Error("the probe was cancelled"));
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("the probe was cancelled")), { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// Resolves with the first ws endpoint the engine prints on stdout or stderr.
function waitForEndpoint(child: EngineProcess, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("the engine did not print a connection endpoint in time"));
    }, timeoutMs);
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const match = buffer.match(/ws:\/\/[^\s"'<>]+/);
      if (match) {
        cleanup();
        resolve(match[0]);
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(`the engine exited with code ${code ?? "unknown"} before printing a connection endpoint`),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", onExit);
  });
}

async function probeDomains(
  client: CDP.Client,
  sessionId: string | undefined,
): Promise<{ supported: string[]; unsupported: string[] }> {
  // SAFETY: see the same cast in runProbe. The method and parameters are CDP
  // protocol strings, which the overloaded typed send cannot accept directly.
  const sendRaw = client.send.bind(client) as unknown as SendRaw;
  const supported: string[] = [];
  const unsupported: string[] = [];
  for (const domain of REQUIRED_DOMAINS) {
    try {
      await withTimeout(sendRaw(`${domain}.enable`, {}, sessionId), 5000, `${domain}.enable`);
      supported.push(domain);
    } catch {
      unsupported.push(domain);
    }
  }
  return { supported, unsupported };
}

async function runProbe(
  binaryPath: string,
  endpointTimeoutMs: number,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  throwIfAborted(signal);
  const aborted = abortPromise(signal);
  const child = spawn(binaryPath, ["serve"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  // Spawn failures surface through the error event, not the exit event.
  const spawnFailed = new Promise<never>((_resolve, reject) => {
    child.once("error", (error) => reject(new Error(`I could not start the engine: ${error.message}`)));
  });

  let client: CDP.Client | undefined;
  try {
    const endpoint = await Promise.race(
      [spawnFailed, waitForEndpoint(child, endpointTimeoutMs), aborted].filter(Boolean) as Promise<unknown>[],
    );
    const wsUrl = endpoint as string;
    throwIfAborted(signal);
    const connectPromise = CDP({ target: wsUrl }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : "the connection failed";
      throw new Error(`I could not open a CDP connection to the engine: ${detail}`);
    });
    client = (await Promise.race(
      [spawnFailed, connectPromise, aborted].filter(Boolean) as Promise<unknown>[],
    )) as CDP.Client;

    // The spec's connection contract: attach to the single page target when the
    // engine exposes a browser level endpoint, otherwise probe the session we
    // are already on.
    let sessionId: string | undefined;
    try {
      // SAFETY: the library's send is overloaded on a fixed protocol mapping, but we
      // probe by raw method name because the engine's coverage is the thing under
      // test. The cast only relaxes the parameter types; behavior is unchanged.
      const sendRaw = client.send.bind(client) as unknown as SendRaw;
      const targets = (await sendRaw("Target.getTargets")) as
        | { targetInfos?: Array<{ targetId: string; type: string }> }
        | undefined;
      const pageTarget = (targets?.targetInfos ?? []).find((target) => target.type === "page");
      if (pageTarget) {
        const attached = (await sendRaw("Target.attachToTarget", {
          targetId: pageTarget.targetId,
          flatten: true,
        })) as { sessionId?: string } | undefined;
        sessionId = attached?.sessionId;
      }
    } catch {
      // No browser level Target domain; the connected session is the page.
    }

    const { supported, unsupported } = await probeDomains(client, sessionId);
    const lines = [`Engine found at ${binaryPath} and a CDP connection is up.`];
    lines.push(`Supported domains: ${supported.join(", ") || "none"}.`);
    if (unsupported.length > 0) {
      lines.push(
        `Unsupported: ${unsupported.join(", ")}. Tools that need those domains fail in plain words; ` +
          "if a required domain is missing, route back through /architect before slice 1 builds on it.",
      );
    } else {
      lines.push("All required domains for navigation and reading are present, so slice 1 can build on this.");
    }
    return {
      message: lines.join("\n"),
      binaryFound: true,
      binaryPath,
      connected: true,
      supportedDomains: supported,
      unsupportedDomains: unsupported,
    };
  } finally {
    if (client) {
      client.close().catch(() => {});
    }
    if (child.exitCode === null) {
      child.kill();
    }
  }
}

export async function probeEngine(options: ProbeOptions = {}): Promise<ProbeResult> {
  const endpointTimeoutMs = options.endpointTimeoutMs ?? 10_000;
  const binaryPath = findBinary();
  if (!binaryPath) {
    return {
      // Spec 0002 message catalog, AC-1: the missing binary names the way out.
      message:
        "The engine is not installed. Run /browser-install, or ask the agent to call browser_install.",
      binaryFound: false,
      connected: false,
      supportedDomains: [],
      unsupportedDomains: [...REQUIRED_DOMAINS],
    };
  }
  try {
    return await withTimeout(runProbe(binaryPath, endpointTimeoutMs, options.signal), 30_000, "engine probe");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "the probe failed for an unknown reason";
    return {
      message: detail,
      binaryFound: true,
      binaryPath,
      connected: false,
      supportedDomains: [],
      unsupportedDomains: [...REQUIRED_DOMAINS],
    };
  }
}