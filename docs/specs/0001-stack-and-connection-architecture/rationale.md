# 0001. Rationale (decision record)

## Context

The scope (`docs/scope/scope.md`) plans a pi extension that gives the pi agent a real browsing engine. Obscura is a Rust headless browser built for AI agents and scraping: it runs JavaScript through V8, implements the Chrome DevTools Protocol (CDP, the WebSocket protocol Chrome tools speak), and is designed to work with existing CDP clients. Pi has no built in browser tools, so the plugin owns the whole surface: managing the engine process and exposing navigate, read, and act tools through `pi.registerTool`.

The forces at play:

- **pi fixes the runtime.** An extension is TypeScript inside pi's own Node process, loaded through jiti with no build step. Choosing anything else (a separate daemon, another language) would fight the host.
- **Obscura fixes the protocol.** The engine speaks CDP. The open question is which client library speaks it with us, and how much abstraction we want between our tools and the wire.
- **A young engine.** Obscura's CDP compatibility is advertised but not proven against every domain. Abstractions built for Chromium may assume things Obscura does not do; debugging through such an abstraction is harder than debugging the wire directly.
- **The project is a tracer bullet build** (scope default). The foundation only needs to be right, not complete: a thin end to end path first, thickened slice by slice.
- **Solo developer, Alpha workflow tier.** No test suite by default; verification drives the real plugin. Simplicity and fast reload loops matter more than framework comfort.

Not deciding stalls everything: features 4 through 8 (binary helper, lifecycle, navigation, interaction, script and wait) all assume a connection architecture and a package shape.

## Options considered

### Option 1: chrome-remote-interface, raw CDP (chosen)

A thin TypeScript client that maps CDP methods to JavaScript calls, nothing more. We spawn Obscura, connect to its WebSocket endpoint, and drive Page, DOM, DOMSnapshot, and Runtime domains directly, with our own small helpers for navigation, reading, and interaction.

**Pros**:
- Full protocol access; whatever Obscura implements, we can call
- No Chromium shaped assumptions; the engine's actual behavior is visible at the call site
- Small, maintained dependency (MIT, registry updates into 2026, roughly a million weekly installs)
- Easy reload loop, nothing to compile, easy to debug at the wire level

**Cons**:
- High level actions (click, fill, wait for selector) are ours to write in slices 2 and 3
- Protocol errors surface raw without a library smoothing them

### Option 2: puppeteer-core over CDP

Connect puppeteer-core to Obscura's endpoint via `browserWSEndpoint` (the engine advertises Puppeteer compatibility). Click, type, and wait helpers come free.

**Pros**:
- Mature high level API, element handles, selector waits, input helpers for free
- Obscura explicitly targets Puppeteer compatibility, so the path is intended to work

**Cons**:
- Large dependency shaped around Chromium internals; its assumptions (target discovery, session flakiness workarounds, version specific behaviors) may not all hold on a third party engine
- Debugging a mismatch means reading puppeteer's Chromium pathing, not the CDP wire
- Heavier than the problem needs: we control the engine version, so Chromium's own compatibility shims buy little

### Option 3: Playwright connectOverCDP

The richest high level API of the three, with Playwright's tracing and selectors.

**Pros**:
- Best in class API and tooling if it works

**Cons**:
- Heaviest dependency of all
- `connectOverCDP` supports a subset of CDP; the subset is defined against Chromium, and behavior on Obscura is the least certain of the three options
- Its strengths (tracing, multi browser, codegen) serve testing suites, not a live agent tool surface

### Option 4: Obscura's built in MCP server

Obscura ships an MCP server crate (obscura-mcp). Connect pi to it and skip custom CDP code entirely.

**Pros**:
- Zero custom connection code; tools exist today

**Cons**:
- The tool surface, output shapes, and UX become Obscura's, not ours; the scope explicitly says this plugin owns the whole surface
- Tool results would not match pi's own conventions (markdown reads with stable element refs, plain language errors), and reshaping them from outside an MCP boundary is harder than owning the client
- The interaction model (element references refreshed after each action, feature 7) is exactly the part Obscura's generic tools do not promise

## Rationale

Option 1 wins because the host already fixed the runtime and the engine already fixed the protocol, so the only real question is how much abstraction to buy. Every abstraction (puppeteer, Playwright) is tuned to Chromium, and its value is the helpers; but those helpers are the same code we must write anyway in slices 2 and 3, and writing them over raw CDP keeps each one honest against the engine we actually run. When Obscura misbehaves, we debug one thin layer we own, not a Chromium tuned stack below it. The cost is some self written interaction code, which the tracer bullet approach wants anyway: the first slice proves the wire, later slices thicken it one helper at a time.

The element reference model (CDP node IDs, no page mutation) follows from the same logic: it uses only the protocol Obscura promises, and it keeps the interaction tools verifiable, since a ref is a node the read result actually showed the agent. The readability script deferral keeps slice 1 deterministic; it can be added as an opt in mode later without touching the architecture.

The persistent connection model matches how an agent session works: one browsing context per pi session, page state living in the engine, cleanup at `session_shutdown`. This also lines up with pi's own extension lifecycle rules (no background resources in the factory, start lazily, shut down idempotently).

## Landscape evidence

Checked 2026-09-20 (full notes in `docs/.agent-cache/research/stack-landscape.md`):

> Cross check: a Deepseek read only critique of the drafted spec raised the connection contract gaps (target routing, concurrency, dead engine detection, readiness, ref lifetime, timeouts, error mapping, serialization rules, input mechanism). All nine were folded into the Decision section of `index.md` with the resolutions shown there; its claim that reload skips `session_shutdown` was rejected against the pi docs, which list `reload` as a shutdown reason. Its CRI versus Puppeteer challenge was weighed and the raw CDP choice kept, with the input mechanism pinned as the named slice 2 risk.

- **pi extensions** (local pi package docs, `docs/extensions.md`): TypeScript via jiti, default factory receiving `ExtensionAPI`, `registerTool` with typebox schemas, npm deps from a `package.json` beside the extension, `session_start` / `session_shutdown` lifecycle, `ctx.ui` for status line and notifications, package layout via `"pi": { "extensions": [...] }`.
- **Obscura** (GitHub repo, fetched): Rust headless browser, V8 for JavaScript, CDP server built in (crates/obscura-cdp), advertised as a drop in replacement for headless Chrome with Puppeteer and Playwright, native rendering, Apache 2.0, release binaries per OS on GitHub. Also ships an MCP server crate (declined, Option 4).
- **chrome-remote-interface** (npm registry): MIT, ~1M weekly downloads, updates into February 2026, thin raw CDP client.
- **puppeteer-core** (GitHub, BrowserConnector.ts): connects to an existing endpoint via `browserWSEndpoint`; Chromium shaped assumptions noted.
- **Playwright connectOverCDP**: general knowledge, not re verified this session; treated as the least certain option on a third party engine.

## References

**Project sources** (verifiable, in this repo):
- pi extension docs (installed pi package, `docs/extensions.md`): extension structure, `registerTool`, jiti loading, `session_start` / `session_shutdown`, package layout with `pi.extensions`
- `docs/scope/scope.md` feature 1, the row this spec serves (Beta tier, Tracer Bullet approach)
- Landscape research cache: `docs/.agent-cache/research/stack-landscape.md` (checked 2026-09-20)
- Installed skills: `.agents/skills/obscura/`, `.agents/skills/pi-extension-authoring/`

**Practices & standards**:
- Boring technology: prefer the proven thin client over the heavier framework until a measured need appears
- Chrome DevTools Protocol as the integration contract for Chrome protocol compatible engines
- Lazy resource startup for extension hosts: no background processes in the factory, start at first use, clean up at `session_shutdown`

**Links** (web verified only):
- chrome-remote-interface on npm: https://www.npmjs.com/package/chrome-remote-interface
- Obscura, the Rust headless browser: https://github.com/h4ckf0r0day/obscura
- Puppeteer connector for existing browser endpoints: https://github.com/puppeteer/puppeteer/blob/fa6158a1dfa327df8dc8eea1eb22c49efefb3be5/packages/puppeteer-core/src/common/BrowserConnector.ts
