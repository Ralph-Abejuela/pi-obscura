# Stack landscape research (2026, for spec 0001 stack & architecture)

## pi extension API (local docs, extensions.md)
- Extensions are TypeScript modules loaded via jiti; no compile step needed.
- Entry: default factory function receiving `ExtensionAPI`; can be async.
- Tools: `pi.registerTool({ name, label, description, parameters (typebox), execute })`.
- Commands: `pi.registerCommand`; UI: `ctx.ui.notify/setStatus/setWidget/select/confirm`.
- Lifecycle: `session_start` (reason startup/reload/new/resume/fork), `session_shutdown` for cleanup.
- Long lived resources: do NOT start in the factory; start at `session_start` or first tool use; register idempotent `session_shutdown` cleanup.
- Package layout: directory with `package.json` declaring `"pi": { "extensions": ["./src/index.ts"] }`; npm deps in `dependencies` (runtime installs use `--omit=dev`).
- Types from `@earendil-works/pi-coding-agent`; schemas from `typebox`.
- Distribution: pi packages via npm or git, `pi install` (deferred in scope).

## Obscura engine (github.com/h4ckf0r0day/obscura README + repo tree)
- Rust headless browser for AI agents/scraping; V8 for JS; CDP server built in (crates/obscura-cdp).
- Advertised as drop-in replacement for headless Chrome with Puppeteer and Playwright.
- Native rendering (screenshots, screencast, PDF), ~70 MiB binary, Apache-2.0, GitHub releases per OS.
- Also ships: obscura-cli (worker mode, robots obey), obscura-mcp (built in MCP server crate), docs at docs.obscura.sh.

## CDP client options for Node/TypeScript
- chrome-remote-interface: MIT, ~1M weekly downloads, registry updates into Feb 2026, thin raw CDP client. https://www.npmjs.com/package/chrome-remote-interface
- puppeteer-core: connects to an existing endpoint via `browserWSEndpoint` (BrowserConnector.ts); Chromium shaped assumptions; Obscura advertises Puppeteer compatibility. https://github.com/puppeteer/puppeteer
- playwright connectOverCDP: richest high level API, heaviest dependency, subset of CDP features over connectOverCDP.
