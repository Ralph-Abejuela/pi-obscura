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
import {
  CONFIG_PATH,
  loadConfig,
  readRawConfig,
  setConfigValue,
  stealthSupport,
} from "./config.js";
import { InstallError, installObscura } from "./installer.js";
import { chooseRef, clickRef, fillRef, keyPress, scrollPage, typeRef } from "./interact.js";
import { evalInPage, waitForMatch } from "./script.js";
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

// The status line label a wait writes for its duration: the one mode it is
// watching and the literal it was given (spec 0007 AC-10).
function watchingLabel(params: { text?: string; selector?: string; condition?: string }): string {
  if (params.text !== undefined) return `text "${params.text}"`;
  if (params.selector !== undefined) return `selector ${params.selector}`;
  if (params.condition !== undefined) return `condition ${params.condition}`;
  return "nothing";
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
        lines.push(
          `Config file: ${snap.configPath}${snap.configIssues.length === 0 ? " (no warnings)" : ""}`,
        );
        for (const issue of snap.configIssues) {
          lines.push(`Config warning: ${issue.key}: ${issue.message}`);
        }
        // AC-3: with stealth on, the probe says in plain words whether the
        // flag was applied and what to do if the binary lacks support.
        if (snap.config.stealth) {
          const verdict = snap.stealthVerdict;
          if (verdict) {
            lines.push(`Stealth: ${verdict.message}.`);
            lines.push(
              verdict.supported
                ? "The engine started with stealth."
                : "The engine started without stealth.",
            );
          } else {
            lines.push("Stealth is on; the capability check has not run yet.");
          }
        }
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
            configPath: snap.configPath,
            config: snap.config,
            configIssues: snap.configIssues,
            stealthVerdict: snap.stealthVerdict,
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
            configPath: snap.configPath,
            config: snap.config,
            configIssues: snap.configIssues,
            stealthVerdict: snap.stealthVerdict,
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

  // Spec 0005 AC-6: the plugin's one settings surface. The view form prints
  // the effective values with their source (file or default) plus the engine
  // facts; the set form validates a value before writing and refuses a wrong
  // type or an out of range value with a plain message. Whether the file or a
  // command changed, the change applies at the next engine start.
  pi.registerCommand("browser-config", {
    description:
      "Show the plugin config and engine facts, or change one setting with set <key> <value>",
    handler: async (args, ctx) => {
      const tokens = args
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 0);

      // Set form: validate before writing; refuse a wrong type or an out of
      // range value with the file left unchanged (AC-6).
      if (tokens[0] === "set") {
        const key = tokens[1];
        if (!key) {
          ctx.ui.notify(
            "Usage: /browser-config set <key> <value>. Keys: binaryPath, stealth, port, " +
              "connectTimeoutMs, spawnTimeoutMs, stopGraceMs. An empty value clears binaryPath or port.",
            "warning",
          );
          return;
        }
        const rawValue = tokens.slice(2).join(" ");
        const outcome = setConfigValue(key, rawValue);
        if (!outcome.ok) {
          ctx.ui.notify(outcome.message, "warning");
          return;
        }
        const lines = [outcome.changed];
        if (outcome.garbageDropped) {
          lines.push(
            "The file did not parse as JSON, so it was rewritten from this edit alone; " +
              "anything unreadable was dropped.",
          );
        }
        if (outcome.after.issues.length === 0) {
          lines.push("No config warnings.");
        } else {
          for (const issue of outcome.after.issues) {
            lines.push(`Config warning: ${issue.key}: ${issue.message}`);
          }
        }
        lines.push("The change applies at the next engine start; there is no auto restart.");
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (tokens.length > 0) {
        ctx.ui.notify(
          "Usage: /browser-config for the view, or /browser-config set <key> <value> to change " +
            "one setting.",
          "warning",
        );
        return;
      }

      // View form: every key with its effective value and source, the engine
      // facts, and the stealth capability verdict run on demand (AC-3, AC-6).
      const loaded = loadConfig();
      const cfg = loaded.config;
      const raw = readRawConfig();
      const present = (key: string): boolean => raw.kind === "readable" && key in raw.record;
      const snap = engine.snapshot();
      const lines = [`Config file: ${CONFIG_PATH}`];
      lines.push(
        `binaryPath: ${cfg.binaryPath ?? "not set; the engine search order finds the binary"} (${present("binaryPath") ? "file" : "default"})`,
      );
      lines.push(
        `stealth: ${cfg.stealth ? "on" : "off"} (${present("stealth") ? "file" : "default"})`,
      );
      lines.push(
        `port: ${cfg.port ?? "auto; a free port is picked at each start"} (${present("port") ? "file" : "default"})`,
      );
      lines.push(
        `connectTimeoutMs: ${cfg.connectTimeoutMs} (${present("connectTimeoutMs") ? "file" : "default"})`,
      );
      lines.push(
        `spawnTimeoutMs: ${cfg.spawnTimeoutMs} (${present("spawnTimeoutMs") ? "file" : "default"})`,
      );
      lines.push(
        `stopGraceMs: ${cfg.stopGraceMs} (${present("stopGraceMs") ? "file" : "default"})`,
      );
      if (loaded.issues.length === 0) {
        lines.push("No config warnings.");
      } else {
        for (const issue of loaded.issues) {
          lines.push(`Config warning: ${issue.key}: ${issue.message}`);
        }
      }
      lines.push(
        `Engine: ${engine.statusText()}${snap.binaryPath ? `; binary at ${snap.binaryPath}` : ""}${snap.endpoint ? `; endpoint ${snap.endpoint}` : ""}`,
      );
      const resolvedBinary = cfg.binaryPath ?? snap.binaryPath;
      if (resolvedBinary) {
        // AC-3: the view runs the capability check on demand, so the verdict
        // shows even when stealth is off.
        const verdict = await stealthSupport(resolvedBinary);
        lines.push(`Stealth: ${cfg.stealth ? "on" : "off, not applied"}. ${verdict.message}.`);
      } else {
        lines.push("Stealth check: no engine binary found; nothing to check.");
      }
      lines.push("A changed value applies at the next engine start; there is no auto restart.");
      ctx.ui.notify(lines.join("\n"), "info");
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

  function where(report: { url: string; title: string }): string {
    return report.title ? `${report.title} (${report.url})` : report.url;
  }

  // The action tools (feature 7, spec 0006). Every action refreshes the page
  // snapshot at the end, so each result carries fresh refs and a refused ref
  // is always the honest one (AC-2). All of them run through the queue with
  // the abort signal and the 30 second clock, like the slice 1 tools.
  pi.registerTool({
    name: "browser_click",
    label: "Click an element",
    description:
      "Click an element by its ref number from the latest read. The element is scrolled into " +
      "view, its visible center is checked for a cover, and the click is sent as a trusted " +
      "mouse event. The result reports where the page is and fresh refs.",
    promptSnippet: "Click an element by ref",
    promptGuidelines: [
      "Pass a ref from the latest read; a refused ref means the page changed, call browser_read again.",
    ],
    parameters: Type.Object({ ref: Type.Number() }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      try {
        const report = await engine.runExclusive(signal, (handle) =>
          clickRef(handle, params.ref, signal),
        );
        const text =
          `Clicked [${params.ref}] "${report.label}". Now at ${where(report)}. ` +
          `Scroll at (${report.scrollX}, ${report.scrollY}).`;
        return toolResult(text, {
          ref: params.ref,
          label: report.label,
          url: report.url,
          title: report.title,
          refs: report.refs,
          scrollX: report.scrollX,
          scrollY: report.scrollY,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "browser_fill",
    label: "Fill a text input",
    description:
      "Replace the value of a text input or textarea by its ref: focus, select everything, " +
      "then type the value with a trusted text event. Non text inputs (checkbox, radio, " +
      "select, and so on) are refused with the element kind named.",
    promptSnippet: "Fill a text input by ref",
    promptGuidelines: [
      "Pass a ref from the latest read; fill replaces the current value, type appends.",
    ],
    parameters: Type.Object({ ref: Type.Number(), value: Type.String() }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      try {
        const report = await engine.runExclusive(signal, (handle) =>
          fillRef(handle, params.ref, params.value, signal),
        );
        const text =
          `Filled [${params.ref}] with "${params.value}". Now at ${where(report)}. ` +
          `Scroll at (${report.scrollX}, ${report.scrollY}).`;
        return toolResult(text, {
          ref: params.ref,
          url: report.url,
          title: report.title,
          refs: report.refs,
          scrollX: report.scrollX,
          scrollY: report.scrollY,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "browser_type",
    label: "Type into a text input",
    description:
      "Append text to a text input or textarea by its ref, with a trusted text event. " +
      "Non text inputs are refused with the element kind named.",
    promptSnippet: "Type text into an input by ref",
    promptGuidelines: [
      "Pass a ref from the latest read; type appends to the current value, fill replaces it.",
    ],
    parameters: Type.Object({ ref: Type.Number(), text: Type.String() }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      try {
        const report = await engine.runExclusive(signal, (handle) =>
          typeRef(handle, params.ref, params.text, signal),
        );
        const text =
          `Typed "${params.text}" into [${params.ref}]. Now at ${where(report)}. ` +
          `Scroll at (${report.scrollX}, ${report.scrollY}).`;
        return toolResult(text, {
          ref: params.ref,
          url: report.url,
          title: report.title,
          refs: report.refs,
          scrollX: report.scrollX,
          scrollY: report.scrollY,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "browser_choose",
    label: "Choose a select option",
    description:
      "Set a native select's value to a named option by its ref, matched by label text first " +
      "and then by the value attribute, and fire the change event. A missing option is " +
      "refused with the valid labels and values listed.",
    promptSnippet: "Choose a select option by ref",
    promptGuidelines: [
      "Pass the option's visible text or its value; browser_read lists each select's options.",
    ],
    parameters: Type.Object({ ref: Type.Number(), value: Type.String() }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      try {
        const report = await engine.runExclusive(signal, (handle) =>
          chooseRef(handle, params.ref, params.value, signal),
        );
        const text =
          `Chose "${params.value}" in [${params.ref}]. Now at ${where(report)}. ` +
          `Scroll at (${report.scrollX}, ${report.scrollY}).`;
        return toolResult(text, {
          ref: params.ref,
          url: report.url,
          title: report.title,
          refs: report.refs,
          scrollX: report.scrollX,
          scrollY: report.scrollY,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "browser_scroll",
    label: "Scroll the page",
    description:
      "Bring an element by its ref into view, or move the page by a signed amount of pixels " +
      "(by). The result reports the new scroll position and fresh refs.",
    promptSnippet: "Scroll the page by amount or to a ref",
    promptGuidelines: ["Pass one of ref or by; a negative by scrolls up."],
    parameters: Type.Object({
      ref: Type.Optional(Type.Number()),
      by: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      try {
        const report = await engine.runExclusive(signal, (handle) =>
          scrollPage(handle, { ref: params.ref, by: params.by }, signal),
        );
        const moved =
          params.ref !== undefined
            ? `Scrolled [${params.ref}] into view.`
            : `Scrolled by ${params.by}px.`;
        const text = `${moved} Scroll at (${report.scrollX}, ${report.scrollY}). Now at ${where(report)}.`;
        return toolResult(text, {
          ref: params.ref,
          by: params.by,
          url: report.url,
          title: report.title,
          refs: report.refs,
          scrollX: report.scrollX,
          scrollY: report.scrollY,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "browser_key",
    label: "Press a key",
    description:
      "Send a named key (Enter, Tab, Escape, the arrows, Home, End, PageUp, PageDown, " +
      "Backspace, Delete) or a single character, as trusted events to the active element, or to " +
      "the element an optional ref focuses first. Enter on a focused submit control submits. " +
      "Modifier combos are refused: this engine drops modifier state, so a combo would reach " +
      "the page as a plain key.",
    promptSnippet: "Press a named key or a single character",
    promptGuidelines: [
      "Use ref to focus an element first; without it the key goes to the active element.",
      "Do not ask for ctrl, meta, shift, or alt: the engine drops modifier state and the call is refused.",
    ],
    parameters: Type.Object({
      key: Type.String(),
      ref: Type.Optional(Type.Number()),
      // Kept so a modifier request is refused in plain words (spec 0006 AC-7)
      // rather than silently ignored.
      modifiers: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      try {
        const report = await engine.runExclusive(signal, (handle) =>
          keyPress(
            handle,
            { key: params.key, ref: params.ref, modifiers: params.modifiers },
            signal,
          ),
        );
        const text =
          `Pressed ${params.key}. Now at ${where(report)}. ` +
          `Scroll at (${report.scrollX}, ${report.scrollY}).`;
        return toolResult(text, {
          key: params.key,
          ref: params.ref,
          url: report.url,
          title: report.title,
          refs: report.refs,
          scrollX: report.scrollX,
          scrollY: report.scrollY,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  // The script and wait tools (feature 8, spec 0007). These are the only two
  // tools that run caller authored JavaScript in the page, so each result says
  // plainly what the engine did with it: a degraded value is named rather than
  // dumped, a page error is the page's own message, and a wait that ran out of
  // time is honest data rather than a broken call.
  pi.registerTool({
    name: "browser_eval",
    label: "Run JavaScript in the page",
    description:
      "Run your own JavaScript in the page and report the value it produced with its type. The " +
      "expression is a script, so its completion value comes back (`1 + 1` gives 2, " +
      "`const a = 1; a + 1` gives 2). Pass ref to run the expression as the body of a function " +
      "with that element as `this`, where a value needs `return` (`return this.textContent`). " +
      "Set await to true to wait for a promise result, bounded at 30 seconds by the engine " +
      "itself. A DOM element, a Promise, a Map, and a Set are reported in plain words, never " +
      "dumped.",
    promptSnippet: "Run JavaScript in the page and read the value",
    promptGuidelines: [
      "Pass a ref from the latest read; with a ref the expression is a function body, so a value needs return.",
      "Set await: true for a promise result; without it a promise reads as an empty object.",
      "A page error arrives as the page's own message, so fix the expression and call again.",
    ],
    parameters: Type.Object({
      expression: Type.String(),
      ref: Type.Optional(Type.Number()),
      await: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      try {
        const report = await engine.runExclusive(signal, (handle) =>
          evalInPage(
            handle,
            { expression: params.expression, ref: params.ref, await: params.await },
            signal,
          ),
        );
        const lines = [`The script returned ${report.type}: ${report.value}`];
        if (report.note) lines.push(report.note);
        lines.push(`Now at ${where(report)}.`);
        return toolResult(lines.join("\n"), report);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "browser_wait",
    label: "Wait for text, an element, or a condition",
    description:
      "Pause until exactly one of these appears: text (a literal case sensitive substring of " +
      "the page's text), selector (a CSS selector that matches an element), or condition (your " +
      "own JavaScript expression whose completion value is truthy). It polls every 100 ms for " +
      "up to timeoutMs (default 10000, clamped to 500 to 25000). A wait that runs out of time " +
      "is a normal result with appeared: false, where the page is now, and fresh refs, never an " +
      "error. The wait holds the browser queue while it polls, so no other browser call " +
      "interleaves.",
    promptSnippet: "Wait for text, a selector, or a condition",
    promptGuidelines: [
      "Pass exactly one of text, selector, or condition.",
      "A text match is text anywhere in the document, hidden and offscreen text included; this engine cannot test visibility.",
    ],
    parameters: Type.Object({
      text: Type.Optional(Type.String()),
      selector: Type.Optional(Type.String()),
      condition: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // AC-10: the status line names what the wait is watching for its whole
      // duration, then goes back to the engine's own state text.
      const watching = watchingLabel(params);
      ctx.ui.setStatus("browser", `waiting for ${watching}`);
      try {
        const report = await engine.runExclusive(signal, (handle) =>
          waitForMatch(
            handle,
            {
              text: params.text,
              selector: params.selector,
              condition: params.condition,
              timeoutMs: params.timeoutMs,
            },
            signal,
          ),
        );
        const waited = `Waited ${(report.elapsedMs / 1000).toFixed(1)}s for ${report.mode} ${report.watched}`;
        const verdict = report.appeared
          ? ". It appeared."
          : ". It never appeared; read the page to see what is there, or wait again with a longer timeoutMs.";
        const lines = [`${waited}${verdict} Now at ${where(report)}.`];
        for (const note of report.notes) lines.push(note);
        return toolResult(lines.join("\n"), report);
      } catch (error) {
        return errorResult(error);
      } finally {
        ctx.ui.setStatus("browser", engine.statusText());
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
