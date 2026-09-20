// src/index.ts
// Entry point for the obscura-agent pi extension.
// Registers the browser_probe tool and the /browser-status command, and keeps
// the pi status line honest about the engine across sessions and reloads.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { probeEngine } from "./engine.js";
import { installObscura, InstallError } from "./installer.js";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
  // Keep the status line honest across starts, switches, and reloads.
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("browser", "not started");
  });

  pi.registerTool({
    name: "browser_probe",
    label: "Browser engine probe",
    description:
      "Check whether the Obscura browser engine is installed and reachable, and which CDP domains it implements. Run this once before the first browsing task of a session.",
    promptSnippet: "Check whether the browser engine is up before browsing",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, _ctx) {
      const result = await probeEngine({ signal });
      return {
        content: [{ type: "text", text: result.message }],
        details: result,
      };
    },
  });

  pi.registerCommand("browser-status", {
    description: "Report whether the browser engine is installed and reachable",
    handler: async (_args, ctx) => {
      const result = await probeEngine({ signal: ctx.signal });
      ctx.ui.setStatus("browser", result.connected ? "engine ready" : "no engine");
      ctx.ui.notify(result.message, result.connected ? "info" : "warning");
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
        ctx.ui.setStatus("browser", "engine ready");
        return { content: [{ type: "text", text: report.message }], details: report };
      } catch (error) {
        const text =
          error instanceof InstallError ? error.message : `The install failed (${errorText(error)}).`;
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
          error instanceof InstallError ? error.message : `The install failed (${errorText(error)}).`;
        ctx.ui.setStatus("browser", "no engine");
        ctx.ui.notify(text, "warning");
      }
    },
  });
}