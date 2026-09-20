# 0001. Stack and connection architecture for the Obscura pi plugin

**Date**: 2026-09-20
**Status**: In Progress

## Summary

This spec decides how the plugin is built and how it talks to the Obscura browser engine. The plugin is a TypeScript extension package for pi (pi loads TypeScript directly, no build step), and it reaches the engine over the Chrome DevTools Protocol (CDP, the wire protocol Chrome based browsers speak) using the small, focused client library chrome-remote-interface. One persistent connection is opened on first tool use and reused, pages are read by taking a CDP DOM snapshot and serializing it to markdown, and interactive elements get stable references from CDP node IDs. Every later slice builds on this structure.

## Decision

**Chosen option**: Option 1, a TypeScript pi extension package that spawns and manages Obscura and speaks raw CDP to it through chrome-remote-interface, with one persistent connection per session.

**Implementation skills**: `obscura` (`h4ckf0r0day/obscura`, `.agents/skills/obscura/`) · `pi-extension-authoring` (`romiluz13/pi-agent-skills`, `.agents/skills/pi-extension-authoring/`)

**Sub decisions** (confirmed with the engineer during the stack walk):

1. **Connection client**: chrome-remote-interface, raw CDP. No Puppeteer, no Playwright. Obscura advertises CDP compatibility, and a thin client keeps our assumptions about the engine visible instead of buried in a Chromium shaped abstraction.
2. **Packaging**: an npm package extension. A directory with `package.json` declaring the pi entry (`"pi": { "extensions": ["./src/index.ts"] }`), npm dependencies in `dependencies` (pi installs runtime deps with `--omit=dev`). This is the shape the deferred `pi install` publishing path needs, so no restructure later.
3. **Element references**: CDP backend node IDs taken from DOM snapshots. The read tool returns markdown plus a reference list (`[1]`, `[2]`, ... each mapped to a node ID); interaction tools accept those references. No attributes are injected into pages.
4. **Connection model**: one persistent CDP connection, opened lazily on first tool use, reused across tool calls, closed on `session_shutdown`. Page state (current URL, history) lives in the engine across calls.
5. **Page reading**: DOMSnapshot serialization in slice 1, deterministic, no scripts run in the page. An in page readability script (Readability style extraction via Runtime.evaluate) is deferred to a later slice as an opt in mode.

**Connection contract** (settled after an independent cross check of the drafted spec; these close the gaps a builder would otherwise have to invent):

- **Target routing**: connect to Obscura's browser level endpoint and attach to the single page target with `Target.attachToTarget` (flatten mode, one CDP session). Multiple tabs are deferred in the scope, so one page target is the whole surface for now.
- **Concurrent tool calls**: pi can dispatch tool calls in parallel, so all browser operations run through one queue inside the extension; CDP work never interleaves.
- **Dead engine detection**: an `exit` listener on the spawned process plus a WebSocket close handler marks the engine dead; the next tool call fails in plain words. Whether and how to auto restart is feature 5's decision (server lifecycle).
- **Connect readiness**: the connection layer waits for the engine's printed endpoint line with a connect timeout, default 10 seconds. The value becomes feature 3 config.
- **Ref lifetime**: a ref is valid until the next navigation or a failed resolution. Interaction tools resolve the backend node ID first; if the node is gone, the tool answers that the page changed and the agent should read again, never guesses.
- **Timeouts and abort**: every tool races its CDP work against pi's abort signal and a default 30 second tool timeout. No CDP call can hang a tool forever.
- **Error mapping**: one small mapper turns CDP and connection errors into four categories (engine down, page error, protocol unsupported, timeout), each with a plain message and a next step.
- **Read serialization rules**: refs number interactive elements only (links, buttons, inputs, selects, textareas) in document order; all other content serializes as plain markdown with no ref.
- **Input mechanism** (slice 2 risk point): clicks and fills go through the CDP Input domain at the element's computed quad center (`getContentQuads`) after scroll into view (`DOM.scrollIntoViewIfNeeded`). Hand rolled input on a non Chromium layout engine can silently mis-hit, so slice 2 verifies hit accuracy on real pages early and routes back through /architect if it does not hold.

**Internal calls made by the architect** (recommendations settled here, the engineer may override any of them):

- **Tool naming**: tools use a `browser_` prefix (`browser_navigate`, `browser_read`, `browser_click`, ...). The surface is generic browsing, the engine name is an implementation detail the model does not need. Runner up: an `obscura_` prefix, dropped because swapping engines should not rename tools.
- **Capability probe at connect**: on first connect, probe the CDP domains Obscura actually implements (a cheap `Domain.enable` per domain we use, starting with Page, DOM, DOMSnapshot, Runtime) and report missing ones in plain words when a tool needs them. Obscura is young and its CDP coverage may be partial; failing with a clear message beats hanging on an unimplemented method. Runner up: assume full Chrome CDP coverage and let errors surface raw.
- **Dev install wiring**: the repo root is the package; during development it is wired into pi through the `extensions` array in pi's `settings.json` pointing at this repo (pi also supports `pi -e ./path` for quick tests). Runner up: symlink into `~/.pi/agent/extensions/`, dropped because the settings path keeps the working copy in the repo where it is edited.
- **Engine target**: the connection target is the WebSocket endpoint Obscura prints when it starts (typically `ws://127.0.0.1:<port>`); where the port and binary path come from is feature 3's decision (plugin state and configuration), not this one. This spec only fixes that the extension reads it, it does not hardcode it.

## Proposed stack

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript (no build step) | pi loads extensions through jiti, so TypeScript runs directly; types come from `@earendil-works/pi-coding-agent` |
| Runtime | Node.js, inside pi's process | Extensions are modules in the pi host process, no separate service to run |
| Extension surface | pi ExtensionAPI, `registerTool` with typebox schemas | The native way pi exposes tools to the model; status line via `ctx.ui`, cleanup via `session_shutdown` |
| Engine connection | chrome-remote-interface over CDP WebSocket | Thin, maintained (registry updates into 2026, MIT), full protocol access, zero Chromium coupling |
| Engine process | Obscura binary spawned and supervised by the extension (`node:child_process`) | The plugin owns the engine lifecycle so tools always have a live engine behind them (feature 5 builds the detail) |
| Element references | CDP backend node IDs from DOM snapshots | No page mutation, works over raw CDP; the snapshot is retaken per read, so a ref always maps to a node the agent actually saw |
| Page serialization | DOMSnapshot to markdown, extension side | Deterministic, no scripts run in pages; readability script deferred to a later slice |
| Packaging | npm package extension, `package.json` with `pi.extensions` entry | npm deps resolve from the package dir; matches the deferred `pi install` publishing path |
| Observability | pi status line (`ctx.ui.setStatus`) plus plain language tool results | The visible surface of an extension is pi itself; no extra logging infra |

Layers with no row (database, auth, hosting, background jobs) do not apply: there is no server, no persistence, and no deployment target beyond pi itself.

## Consequences

**Positive**:
- Every later slice builds on real structure: the scaffold from the stack decision is the package every tool lands in, and the persistent connection is the single place page state flows through.
- Raw CDP keeps the whole protocol reachable, so whatever Obscura implements we can use without waiting for a higher level library to expose it.
- Node IDs as references mean interaction tools stay honest: a ref is a node the agent actually saw in a read result, not a selector it guessed.
- No build step: edit TypeScript, reload pi, the change is live. The tracer bullet loop (edit, reload, prove) stays seconds short.

**Negative / tradeoffs**:
- We write our own helpers for what Puppeteer gives free (click, fill, wait for selector). This is real code in slices 2 and 3, accepted because it stays small over raw CDP and keeps engine behavior transparent.
- chrome-remote-interface is a thin layer, so protocol level errors (unknown method, missing domain) surface directly; the capability probe and plain error mapping exist to absorb this.
- Node IDs go stale on navigation and DOM changes; every read re snapshots and interaction tools must validate a ref before use, re reading when it is stale. That validation is our responsibility, not the library's.
- The plugin depends on Obscura's CDP compatibility claims being true in practice; the first tracer bullet run is exactly that proof, and a mismatch found there routes back through /architect.

## Follow-up

- [ ] The `obscura` and `pi-extension-authoring` skills were installed this session into `.agents/skills/`; root `AGENTS.md` does not exist yet, so /audit (feature 2, coding standards and tooling) should record both skills in its `## Agent skills` section.
- [ ] Verify Obscura's CDP coverage for the domains this stack needs (Page, DOM, DOMSnapshot, Runtime) during the scaffold tracer bullet; if a domain is missing or partial, route back through /architect before slice 1 builds on it.
- [ ] The in page readability script (Readability style extraction) is deferred to a later slice as an opt in read mode; consider enrolling it as a scope feature when slice 3 lands.
- [ ] Feature 3 (plugin state and configuration) decides where the Obscura binary path, port, and connection settings come from; this spec fixes only that the extension reads them rather than hardcoding.

## Rationale

Reasoning, options, and references: see [rationale.md](rationale.md).
