# Scope: Obscura browser plugin for pi

A pi extension that gives the agent a real browsing engine. Obscura is a Rust headless browser that speaks the same protocol as Chrome without running Chrome, and this plugin manages an Obscura process for you and exposes browser tools through pi's own tool surface. Pi has no built in browser tools, so the plugin owns the whole surface: finding and running the engine, then letting the agent navigate, read, and act on real pages.

**Build approach:** Tracer Bullet (prove one thin, real path from pi tool to browser page first, then thicken each strand).
**Workflow:** Alpha (after `/develop`, `/check verify` drives the real plugin; no test suite or second model review by default). The project default level of rigor. `/architect` is the recommended first stop for a feature with a real decision, but skippable when you already know the build. Any feature can carry its own tag (e.g. `· Beta`) to do more or less.

_These are recommendations to keep your build orderly, not requirements. Skip anything that does not fit: if you already know how to build a feature, use `/develop` and skip `/architect`. You decide when a feature is `done`._

## At a glance

| # | Feature | Phase | Status |
|---|---------|-------|--------|
| 1 | Stack & architecture | Foundation | in-progress (verified) |
| 2 | Coding standards & tooling | Foundation | done |
| 3 | Plugin state & configuration | Foundation | done |
| 4 | Obscura binary helper | Slice 1 | done |
| 5 | Server lifecycle | Slice 1 | done |
| 6 | Core navigation & reading | Slice 1 | done |
| 7 | Interaction tools | Slice 2 | planned |
| 8 | Script & wait | Slice 3 | planned |

## Foundations

### 1. Stack & architecture · Beta
Decide how pi tools reach the browser engine and scaffold the package so every later slice builds on real structure. This is an extension with no app UI, so there is no design system foundation; the visible surface is the pi status line, notifications, and tool results, all covered by the state feature below.
spec [0001](../specs/0001-stack-and-connection-architecture/index.md) · code in src/
**Done when:** the spec records the connection architecture (how the tool layer and the engine talk), the package scaffold boots under `pi -e`, and a reload leaves the session intact.
- [x] Decide the stack (spec): `/architect stack & architecture`
- [x] Build it: `/develop stack & architecture`
- [x] Verify it: `/check verify stack & architecture`
- [ ] Test it: `/test stack & architecture`

### 2. Coding standards & tooling
Capture conventions, then install lint, format, typecheck, and pre commit enforcement from the real scaffolded package.
**Done when:** root `AGENTS.md` reflects the real stack, and lint, format, typecheck, and pre commit all run clean.
- [x] Capture conventions + tooling choices: `/audit`
- [x] Install the tooling: `/develop tooling`
- [x] Verify it runs clean: `/check verify tooling`

### 3. Plugin state & configuration
One place for settings and session state, so every tool reads the same config and the plugin survives a `/reload` without losing track of the engine.
spec [0005](../specs/0005-plugin-state-and-configuration/index.md) · code in src/ (config.ts, supervisor.ts, index.ts)
**Done when:** config (binary path, stealth, timeouts) reads from one source and applies at startup, state reconstructs after a hot reload, and errors reach you in plain words with a clear next step.
- [x] Design it (spec): `/architect plugin state & configuration`
- [x] Build it: `/develop plugin state & configuration`
  - [x] Config module, defaults, first wiring · AC-1, AC-5
  - [x] Explicit port and stealth spawn · AC-2, AC-3
  - [x] /browser-config command · AC-6
  - [x] Reload, reporting, self check · AC-4
- [x] Verify it: `/check verify plugin state & configuration`

## Slice 1: the walking thread

The thinnest real path, end to end and working: binary present, engine running, agent opens a page and reads it. This slice merges with the walking skeleton; nothing here is faked or stubbed.

### 4. Obscura binary helper
When the engine is missing, tell you plainly and get it installed, so the first run is not a dead end.
spec [0002](../specs/0002-obscura-binary-helper/index.md) · code in src/ (installer.ts, engine.ts, index.ts)
**Done when:** a missing binary produces a clear next step, and the install command downloads the right release build for this OS, extracts it, and verifies it runs.
- [x] Design it (spec): `/architect obscura binary helper`
- [x] Build it: `/develop obscura binary helper`
  - [x] Install pipeline, map, download, extract, verify · AC-2, AC-3, AC-4, AC-5, AC-9
  - [x] Surfaces and consent, command, tool, overwrite ask, probe message · AC-1, AC-6, AC-7
  - [x] Auto probe after install · AC-8
- [x] Verify it: `/check verify obscura binary helper`

### 5. Server lifecycle
Start, watch, and stop the engine with the session, so tools always have a live engine behind them without you managing processes.
spec [0003](../specs/0003-server-lifecycle/index.md) · code in src/ (supervisor.ts, index.ts, engine.ts)
**Done when:** the engine starts on first use, reports ready in the pi status line, and stops cleanly when the session ends; a dead engine is detected and reported in plain words, and the next browser call restarts it, so nothing hangs.
- [x] Design it (spec): `/architect server lifecycle`
- [x] Build it: `/develop server lifecycle`
  - [x] Persistent engine, lazy start, status line · AC-1
  - [x] Death detection, restart on next use, queue ownership · AC-3, AC-4
  - [x] Crash loop guard, fail fast after two failed starts · AC-5
  - [x] Clean stop on shutdown and reload · AC-2, AC-7
  - [x] Stale port report, never kill an unowned process · AC-6
- [x] Verify it: `/check verify server lifecycle`

### 6. Core navigation & reading
The read loop that makes the engine useful: go to a page, see what is on it as readable text with the interactive elements, and move around.
spec [0004](../specs/0004-core-navigation-and-reading/index.md) · code in src/ (browser.ts, supervisor.ts, index.ts)
**Done when:** the agent can open a URL, read the page as markdown with interactive element references, follow links, and go back, forward, and reload, all through pi tools.
- [x] Build it: `/develop core navigation & reading`
  - [x] Session page and queue: createTarget at connect, runExclusive serialization · AC-1, AC-9
  - [x] Navigation and reload: URL validation, Page.navigate and readyState wait, plain refusals; Page.reload · AC-1, AC-2, AC-7
  - [x] Reading: DOM snapshot to markdown with interactive refs and truncation · AC-3, AC-4, AC-8
  - [x] History: back and forward through engine history entries · AC-5, AC-6
  - [x] Tool wiring and self check: five tools, abort and timeout bounds, error mapper, navigation-selfcheck.ts · AC-9
- [x] Verify it: `/check verify core navigation & reading`

## Slice 2: act on the page

### 7. Interaction tools
Act on the page the way a person would: click, fill, type, choose, scroll, and keep the agent's element references honest after each action.
**Done when:** the agent can complete a multi step flow, like searching, filling a form, and submitting it, with element references refreshed after each action.
- [ ] Build it: `/develop interaction tools`

## Slice 3: reach in and wait

### 8. Script & wait
Run your own JavaScript in the page and synchronize with changing content before reading on.
**Done when:** the agent can evaluate JS on the page and pause until text or a condition appears, then read the result.
- [ ] Build it: `/develop script & wait`

## Deferred
Out of scope for this build pass, kept so the plan stays honest.
- **Visual output**: screenshot the current page and hand the image to the model, and export PDFs; needs a render enabled build (the default Windows release includes rendering).
- **Readability read mode**: an opt in extraction mode on the read tool (Readability style, scripts run in the page) for heavy article pages · from spec 0001
- **State & persistence**: cookies and a saved profile so logins survive between sessions.
- **Tabs & diagnostics**: multiple tabs, network requests, and console messages.
- **Remote attach mode**: connect to an engine running elsewhere (Docker, another machine) instead of spawning locally.
- **Publishing**: an npm release and a polished README so others can `pi install` the package.
- **Engine update checks**: notice and offer newer engine releases; reinstalling is the update path today · from spec 0002

## Legend

**The decision box.** Every feature carries exactly one, the sub task whose label ends with `(spec)`. Its wording varies (`Design it (spec)` normally, `Decide the stack (spec)` on Stack & architecture), so skills locate it by that `(spec)` suffix, never by an exact label. Every other box is an execution box and `/architect` never ticks one.

**Feature lifecycle**: the scope updates as a feature moves; each row is what it shows and who sets it:

| State | Set by | The feature shows |
|---|---|---|
| `planned` · needs a decision | `/scope` | one box: `Design it (spec): /architect <feature>` |
| `in-progress` (designed) | **`/architect` at spec capture** | `Design it` ticked; spec linked; `Build it: /develop <feature>` + 2 to 5 milestones; the tier's closing boxes (`Verify it` Alpha+); any surfaced follow-up enrolled |
| `in-progress` (building) | `/develop` | milestone sub boxes tick one by one; code pointer filled |
| `in-progress` (verified) | `/check verify` | `Build it` + milestones ticked; `Verify it` ticked |
| `done` | **you, when you decide it is** (any skill sets it when you say so); `/sync` reconciles | boxes you ran ticked, skipped ones marked skipped; the tier's last stage (`Prototype` → after `/develop`; `Alpha` → after `/check verify`; `Beta`/`GA` → after `/test`) is the suggested point to call it done; `/sync` captures conventions |

- **Next step** = the first unticked box (always a command or a tracked milestone).
- **needs a decision** = run `/architect` first; otherwise straight to `/develop` (or `/audit` for standards & tooling). The tag drops once the spec is captured.
- **Atomic build tasks live in the spec's `## Build plan`, not here**: the scope carries only the milestone rollup.
- **Status** `planned` → `in-progress` → `done`, plus `existing` (pre workflow) and `dropped` (de scoped, kept for history).
- **Approach tag** beside a heading (e.g. `· Facade`) overrides the project default for that feature; no tag = inherits it.
- **Workflow tier tag** beside a heading (e.g. `· Beta`, `· Prototype`) sets that one feature's rigor above or below the project default; no tag inherits the default. It decides the feature's check boxes and each skill's next suggestion.
- **Workflow** (header line) is the project default, what runs after `/develop`: **Prototype** = nothing (trust develop's own build time self check); **Alpha** = `/check verify`; **Beta** = `/check verify` then `/test`; **GA** = adds a fresh model `/check review` then `/document`. A feature built on an unratified decision (an `Assumed` spec) stays flagged, but that never blocks `done`.
- **Pointer line** (`spec <n> · code in <path>`): the spec link added by `/architect`, the code path by `/develop`.