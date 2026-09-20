// src/index.ts
// Entry point for the obscura-agent pi extension.
// Registers the browser_probe tool and the /browser-status command against the
// persistent engine supervisor (spec 0003), and keeps the pi status line honest
// about the engine across sessions and reloads. The install surfaces
// (browser_install tool, /browser-install command) keep the throwaway probe
// from spec 0002 to verify an install, per the spec 0003 decision.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { goBack, goForward, type NavReport, navigate, readPage, reloadPage } from "./browser.js";
import { InstallError, installObscura } from "./installer.js";
import { createEngineSupervisor } from "./supervisor.js";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ToolResult = { content: { type: "text"; text: string }[]; details: unknown };

function toolResult(message: string, details: unknown): ToolResult {
  return { content: [{ type: "text", text: message }], details };
}

function errorResult(error: unknown): ToolResult {
  const text = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text }], details: undefined };
}

// The navigation tools share one response shape: where the page is now.
function navMessage(report: NavReport, action: string): string {
  const where = report.title ? `${report.title} (${report.url})` : report.url;
  return `${action} ${where}.`;
}

export default function (pi: ExtensionAPI) {
  // One supervised engine per extension instance (spec 0003).
  const engine = createEngineSupervisor();

  pi.on("session_start", async (_event, ctx) => {
    // Bind the status line to this session; a reload or a new session rebinds
    // on a fresh instance. stopEngine is idempotent, a safety net for a same
    // instance reuse.
    engine.bindStatus((text) => ctx.ui.setStatus("browser", text));
    await engine.stopEngine();
  });

  // AC-2 (clean stop on shutdown) and AC-7 (stop on reload): no engine process
  // the plugin spawned survives a session close or a pi hot reload.
  pi.on("session_shutdown", async (_event, _ctx) => {
    await engine.stopEngine();
  });

  pi.registerTool({
    name: "browser_probe",
    label: "Browser engine probe",
    description:
      "Check whether the Obscura browser engine is installed and reachable, and which CDP domains it implements. " +
      "The first call of a session starts the engine; it stays up for the session and later calls report the same engine.",
    promptSnippet: "Check whether the browser engine is up before browsing",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, _ctx) {
      try {
        await engine.ensureEngine(signal);
        const snap = engine.snapshot();
        const lines = [
          `The browser engine is running (${snap.binaryPath ?? "unknown path"}) and a CDP connection is up.`,
          `Supported domains: ${snap.supportedDomains.join(", ") || "none"}.`,
        ];
        if (snap.unsupportedDomains.length > 0) {
          lines.push(`Unsupported: ${snap.unsupportedDomains.join(", ")}.`);
        } else {
          lines.push("All required domains for navigation and reading are present.");
        }
        lines.push(
          "The engine stays up for the session; a dead engine is restarted by the next browser call.",
        );
        const message = lines.join("\n");
        return {
          content: [{ type: "text", text: message }],
          details: {
            message,
            binaryFound: true,
            binaryPath: snap.binaryPath,
            connected: true,
            supportedDomains: snap.supportedDomains,
            unsupportedDomains: snap.unsupportedDomains,
          },
        };
      } catch (error) {
        const snap = engine.snapshot();
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          details: {
            message,
            binaryFound: Boolean(snap.binaryPath),
            binaryPath: snap.binaryPath,
            connected: snap.phase === "ready",
            supportedDomains: snap.supportedDomains,
            unsupportedDomains: snap.unsupportedDomains,
          },
        };
      }
    },
  });

  pi.registerCommand("browser-status", {
    description: "Report whether the browser engine is running and reachable",
    handler: async (_args, ctx) => {
      try {
        await engine.ensureEngine(ctx.signal);
        const snap = engine.snapshot();
        const domains = `Supported: ${snap.supportedDomains.join(", ") || "none"}.`;
        ctx.ui.notify(`Browser engine ${engine.statusText()}. ${domains}`, "info");
      } catch (error) {
        ctx.ui.notify(`Browser engine ${engine.statusText()}: ${errorText(error)}`, "warning");
      }
    },
  });

  // Slice 1 tools (feature 6, core navigation and reading). Every operation
  // runs through the supervisor queue against the one session page, bounded by
  // pi's abort signal and the 30 second tool timeout (spec 0001).
  pi.registerTool({
    name: "browser_navigate",
    label: "Open a page",
    description:
      "Open a URL in the browser engine and wait for the page to finish loading. " +
      "The page stays open for the session until the next navigation; call browser_read to see it.",
    promptSnippet: "Open a page in the browser",
    promptGuidelines: [
      "Pass the full URL including the scheme (https://example.com, not example.com).",
      "The engine refuses private and loopback addresses, so a local test page must be a data: URL or served publicly.",
    ],
    parameters: Type.Object({ url: Type.String() }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      try {
        const report = await engine.runExclusive(signal, (handle) =>
          navigate(handle, params.url, signal),
        );
        return toolResult(navMessage(report, "Opened"), report);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "browser_read",
    label: "Read the current page",
    description:
      "Read the current page as markdown with interactive element references. " +
      "Links are markdown links you can follow with browser_navigate; interactive elements are " +
      "listed at the end with ref numbers mapped to browser node ids for the interaction tools.",
    promptSnippet: "Read the current page as markdown",
    promptGuidelines: [
      "Call browser_navigate first; browser_read reports the page the engine is on.",
      "If the engine says the page changed after an action, read again for fresh refs.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, _ctx) {
      try {
        const report = await engine.runExclusive(signal, (handle) => readPage(handle, signal));
        const heading = report.title ? `# ${report.title}\n` : "";
        const message = `${heading}URL: ${report.url}\n\n${report.markdown}`;
        return toolResult(message, {
          url: report.url,
          title: report.title,
          refs: report.refs,
          truncated: report.truncated,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "browser_back",
    label: "Go to the previous page",
    description:
      "Move back one page in this session's history, to the page the engine was on before the current one.",
    promptSnippet: "Go back to the previous page",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, _ctx) {
      try {
        const report = await engine.runExclusive(signal, (handle) => goBack(handle, signal));
        return toolResult(navMessage(report, "Went back to"), report);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "browser_forward",
    label: "Go to the next page",
    description:
      "Move forward one page in this session's history, after a browser_back moved away from it.",
    promptSnippet: "Go forward to the next page",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, _ctx) {
      try {
        const report = await engine.runExclusive(signal, (handle) => goForward(handle, signal));
        return toolResult(navMessage(report, "Went forward to"), report);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "browser_reload",
    label: "Reload the current page",
    description: "Reload the current page in the engine and wait for it to finish loading again.",
    promptSnippet: "Reload the current page",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, _ctx) {
      try {
        const report = await engine.runExclusive(signal, (handle) => reloadPage(handle, signal));
        return toolResult(navMessage(report, "Reloaded"), report);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  // Consent split (spec 0002 AC-6): the tool always asks before downloading;
  // typing /browser-install is the consent, so the command only asks before
  // an overwrite.
  pi.registerTool({
    name: "browser_install",
    label: "Browser engine installer",
    description:
      "Download and install the Obscura browser engine from its official GitHub releases into " +
      "~/.pi/agent/bin, verify it runs, and report its CDP domain coverage. Asks for consent " +
      "before downloading.",
    promptSnippet: "Install the browser engine when it is missing",
    promptGuidelines: [
      "Use browser_install when browser_probe reports the Obscura engine is not installed.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, onUpdate, ctx) {
      if (!ctx.hasUI) {
        // AC-6: consent has to be possible; without UI there is no ask, so
        // nothing is downloaded.
        return {
          content: [
            {
              type: "text",
              text:
                "Install cancelled; nothing was downloaded or changed. I need an interactive " +
                "pi session to ask your consent before downloading an executable. Start pi " +
                "normally (not in print mode) and ask again, or run /browser-install yourself.",
            },
          ],
          details: undefined,
        };
      }
      try {
        const report = await installObscura({
          signal,
          askOverwrite: (title, message) => ctx.ui.confirm(title, message),
          askConsent: (title, message) => ctx.ui.confirm(title, message),
          onProgress: (percent) =>
            onUpdate?.({
              content: [{ type: "text", text: `Downloading... ${percent}%` }],
              details: undefined,
            }),
        });
        // AC-2 of spec 0002: the install verified the engine, report it ready.
        ctx.ui.setStatus("browser", "engine ready");
        return { content: [{ type: "text", text: report.message }], details: report };
      } catch (error) {
        const text =
          error instanceof InstallError
            ? error.message
            : `The install failed (${errorText(error)}).`;
        ctx.ui.setStatus("browser", "no engine");
        return { content: [{ type: "text", text }], details: undefined };
      }
    },
  });

  pi.registerCommand("browser-install", {
    description: "Download and install the Obscura browser engine (typing this is your consent)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(
          "Install cancelled; nothing was downloaded or changed. I cannot ask before an " +
            "overwrite without an interactive session, so start pi normally and run this again.",
          "warning",
        );
        return;
      }
      ctx.ui.setStatus("browser", "installing...");
      try {
        const report = await installObscura({
          signal: ctx.signal,
          askOverwrite: (title, message) => ctx.ui.confirm(title, message),
          onProgress: (percent) => ctx.ui.setStatus("browser", `installing ${percent}%`),
        });
        ctx.ui.setStatus("browser", "engine ready");
        ctx.ui.notify(report.message, "info");
      } catch (error) {
        const text =
          error instanceof InstallError
            ? error.message
            : `The install failed (${errorText(error)}).`;
        ctx.ui.setStatus("browser", "no engine");
        ctx.ui.notify(text, "warning");
      }
    },
  });
}
