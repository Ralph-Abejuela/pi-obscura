// src/installer.ts
// The Obscura binary installer (spec 0002): map the platform to the right
// official release asset, download it from GitHub releases, extract it with
// the operating system's tar, verify the binary runs, and report the engine's
// protocol coverage. Zero new dependencies: Node's fetch and the OS tar.

import { spawn } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { BIN_DIR, probeEngine } from "./engine.js";

const RELEASE_BASE = "https://github.com/h4ckf0r0day/obscura/releases/latest/download";
const BINARY_NAME = process.platform === "win32" ? "obscura.exe" : "obscura";
const DEST_PATH = join(BIN_DIR, BINARY_NAME);
const EXTRACT_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 10_000;

// Asset selection table from spec 0002; variant is fixed to the default
// render build. Anything not listed has no download (AC-9).
const ASSETS: Record<string, string> = {
  "win32:x64": "obscura-x86_64-windows.zip",
  "darwin:x64": "obscura-x86_64-macos.tar.gz",
  "darwin:arm64": "obscura-aarch64-macos.tar.gz",
  "linux:x64": "obscura-x86_64-linux.tar.gz",
  "linux:arm64": "obscura-aarch64-linux.tar.gz",
};

// An InstallError already carries the user facing wording from the spec's
// message catalog; anything else gets a generic wrap at the surface layer.
export class InstallError extends Error {}

export type Ask = (title: string, message: string) => Promise<boolean>;

export interface InstallOptions {
  /** AC-7: asked before overwriting an existing binary, both surfaces. */
  askOverwrite: Ask;
  /** AC-6: asked before any download, tool surface only. */
  askConsent?: Ask;
  /** Download progress percent (0 to 100). */
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

export interface InstallReport {
  message: string;
  version: string;
  asset: string;
  destination: string;
  coverage?: { supported: string[]; unsupported: string[] };
}

function downloadFailed(reason: string): InstallError {
  return new InstallError(
    `The download failed (${reason}). Check the connection and run the install again. ` +
      "On a proxied network, Node 24 may need NODE_USE_ENV_PROXY=1.",
  );
}

function verifyFailed(): InstallError {
  if (process.platform === "win32") {
    return new InstallError(
      "The engine was installed but would not run. Your antivirus may have blocked it; " +
        "add an exception for the binary or run it once by hand, then run /browser-status.",
    );
  }
  if (process.platform === "darwin") {
    return new InstallError(
      "The engine was installed but macOS blocked it (Gatekeeper quarantine). " +
        "Clear the quarantine flag on the binary or approve it in System Settings, then run /browser-status.",
    );
  }
  return new InstallError(
    "The engine was installed but would not run. The filesystem may be mounted noexec; " +
      "move the binary somewhere executable, then run /browser-status.",
  );
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return "cancelled";
    return error.message;
  }
  return String(error);
}

// Spawn a child with a hard timeout; the child is killed when the timer fires
// or the signal aborts, so a hung child can never wedge the install (AC-4/5).
function runCommand(
  cmd: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// Run a binary with --version; valid only when it exits 0 and prints a
// version style number (AC-5). Anything else reads as "no version".
async function versionOf(binaryPath: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const result = await runCommand(binaryPath, ["--version"], VERSION_TIMEOUT_MS, signal);
    if (result.code !== 0) return undefined;
    const output = result.stdout + result.stderr;
    if (!/\d+\.\d+/.test(output)) return undefined;
    return (output.trim().split("\n")[0] ?? "").slice(0, 80) || undefined;
  } catch {
    return undefined;
  }
}

// Depth first search of the extracted tree; the release archives nest the
// binary differently per platform, any layout is accepted (AC-4).
function findBinaryIn(root: string): string | undefined {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.name === BINARY_NAME) {
        return path;
      }
    }
  }
  return undefined;
}

// ponytail: this module level chain is the "operation queue" for now; feature 5
// (server lifecycle) replaces it with the real shared queue.
let installChain: Promise<unknown> = Promise.resolve();

export function installObscura(options: InstallOptions): Promise<InstallReport> {
  const run = installChain.catch(() => {}).then(() => runInstall(options));
  installChain = run.catch(() => {});
  return run;
}

async function runInstall(options: InstallOptions): Promise<InstallReport> {
  // AC-2/AC-9: map the platform first, fail before any network call.
  const asset = ASSETS[`${process.platform}:${process.arch}`];
  if (!asset) {
    throw new InstallError(
      `No Obscura release exists for ${process.platform} ${process.arch}. ` +
        "Available targets: Windows x64, macOS x64 and arm64, Linux x64 and arm64.",
    );
  }

  // AC-7: report an existing binary and ask before overwriting.
  if (existsSync(DEST_PATH)) {
    const existing = await versionOf(DEST_PATH, options.signal);
    const ok = await options.askOverwrite(
      "Overwrite existing engine?",
      `An engine already exists at ${DEST_PATH} (version ${existing ?? "no version reported"}). ` +
        "Overwrite it with the latest release?",
    );
    if (!ok) throw new InstallError("Install cancelled; nothing was downloaded or changed.");
  }

  // AC-6: the tool surface asks before any bytes move; typing /browser-install
  // is the consent on the command surface, so no ask there.
  if (options.askConsent) {
    const ok = await options.askConsent(
      "Install the Obscura engine?",
      `Download ${asset} (about 72 MB) from the official Obscura GitHub releases and install it to ${BIN_DIR}?`,
    );
    if (!ok) throw new InstallError("Install cancelled; nothing was downloaded or changed.");
  }

  mkdirSync(BIN_DIR, { recursive: true });
  // Same volume temp inside the destination, so the final move is a rename.
  const tempDir = join(BIN_DIR, `.tmp-${process.pid}`);
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir);
  try {
    // AC-3: stream the download and hold it against the response's own
    // Content-Length; nothing is placed until every check has passed.
    const response = await fetch(`${RELEASE_BASE}/${asset}`, {
      signal: options.signal,
      redirect: "follow",
    });
    if (!response.ok || !response.body) {
      throw downloadFailed(`the server answered ${response.status}`);
    }
    const expected = Number(response.headers.get("content-length"));
    if (!expected) throw downloadFailed("the response carried no size to check against");

    const archivePath = join(tempDir, asset);
    const source = Readable.fromWeb(response.body as WebReadableStream);
    let written = 0;
    let lastPercent = 0;
    source.on("data", (chunk: Buffer) => {
      written += chunk.length;
      const percent = Math.min(100, Math.floor((written / expected) * 100));
      if (percent >= lastPercent + 5) {
        lastPercent = percent;
        options.onProgress?.(percent);
      }
    });
    try {
      await pipeline(source, createWriteStream(archivePath));
    } catch (error) {
      throw downloadFailed(reasonOf(error));
    }
    options.onProgress?.(100);
    if (written !== expected) {
      throw new InstallError(
        `The download was incomplete (${written} of ${expected} bytes). ` +
          "Nothing was installed; run the install again.",
      );
    }

    // AC-4: extract with the OS tar into the same volume temp folder.
    try {
      const tar = await runCommand("tar", ["-xf", archivePath, "-C", tempDir], EXTRACT_TIMEOUT_MS, options.signal);
      if (tar.code !== 0) {
        throw new Error(`tar exited with code ${tar.code}${tar.stderr.trim() ? `: ${tar.stderr.trim()}` : ""}`);
      }
    } catch (error) {
      throw new InstallError(
        `The archive could not be extracted (${reasonOf(error)}). Nothing was installed.`,
      );
    }
    const extracted = findBinaryIn(tempDir);
    if (!extracted) {
      throw new InstallError(
        "The archive could not be extracted (no obscura binary inside). Nothing was installed.",
      );
    }
    if (process.platform !== "win32") chmodSync(extracted, 0o755);

    // AC-5: verify before anything lands in the destination.
    const version = await versionOf(extracted, options.signal);
    if (!version) throw verifyFailed();

    rmSync(DEST_PATH, { force: true });
    renameSync(extracted, DEST_PATH);

    // AC-8: the engine probe runs automatically; a probe failure is a
    // warning, the install itself still counts as successful.
    const probe = await probeEngine({ signal: options.signal });
    let coverage: InstallReport["coverage"];
    let probeWarning: string | undefined;
    if (probe.connected) {
      coverage = { supported: probe.supportedDomains, unsupported: probe.unsupportedDomains };
    } else {
      probeWarning =
        `The engine is installed and verified, but the coverage check failed (${probe.message}). ` +
        "Browsing may still work; run /browser-status to retry.";
    }

    const lines = [
      `Installed Obscura ${version} (from ${asset}) at ${DEST_PATH}. Verified: --version runs and reports a version.`,
    ];
    if (coverage) {
      lines.push(`CDP coverage, supported: ${coverage.supported.join(", ") || "none"}.`);
      if (coverage.unsupported.length > 0) {
        lines.push(`Unsupported: ${coverage.unsupported.join(", ")}.`);
      }
    } else if (probeWarning) {
      lines.push(probeWarning);
    }
    return { message: lines.join("\n"), version, asset, destination: DEST_PATH, coverage };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
