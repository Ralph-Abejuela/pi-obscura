# pi-obscura

## Stack

- **Language / Runtime**: TypeScript, no build step (pi runs it through jiti), inside pi's Node process
- **Framework**: pi ExtensionAPI: registerTool with TypeBox schemas, status line through ctx.ui
- **Key dependencies**: chrome-remote-interface (raw CDP), typebox, @earendil-works/pi-coding-agent (types)
- **Package manager**: npm

## Build approach

**Tracer Bullet**: prove one thin, real path from a pi tool to a browser page first, then thicken each strand.

## Commands

```bash
# Install
npm install

# Typecheck
npm run typecheck

# Lint + format (Biome); `npm run fix` auto-applies, `npm run format:write` rewrites formatting
npm run lint
npm run format
npm run fix

# Dev loop
pi -e ./src/index.ts   # or wire this repo into the extensions array in pi settings

# Navigation self check (drives a real page through the built tools)
node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs scripts/navigation-selfcheck.ts

# Interaction self check (the six action tools, the refusal cases, and the recorded engine limits)
node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs scripts/interaction-selfcheck.ts

# Script and wait self check (browser_eval, browser_wait, the wedge recovery cases, and the queue discipline)
node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs scripts/script-selfcheck.ts
```

## Specs

Stored in `docs/specs/`. Format: `docs/specs/NNNN-title/` with index, rationale, verify. The stack decision lives in spec 0001.

## Rules

- Functions are pure by default: same input, same output, no side effects.
- Data is immutable: const, readonly, no in place mutation; module level variables are constants only.
- Side effects (CDP calls, engine process, session state) live at the edges, explicit and isolated.
- Prefer function composition over classes; avoid classes where a plain function works.
- Use map, filter, reduce over imperative loops; avoid null, prefer explicit undefined in union types.
- Expected failures return a tagged error; the error mapper turns CDP errors into four plain categories (engine down, page error, protocol unsupported, timeout), each with a next step.
- Named exports only, no default exports.
- Tools use the browser_ prefix; src is flat, one module per slice (`browser.ts` for navigation and reading, `interact.ts` for the action tools, `script.ts` for the script and wait tools) beside the shared edges (`supervisor.ts`, `engine.ts`, `config.ts`, `installer.ts`) and the pi entry point in `index.ts`.
- Public APIs are documented: every exported symbol a tool or another module calls carries a short plain comment on what it does and when it fails.
- Strict TypeScript: tsconfig strict, no any.
- Engine behaviour is probe verified, never assumed: throwaway probes live in the gitignored `scratch/`, and each verified engine limit is recorded in the owning spec's rationale probe record.
- An active bot challenge is out of reach, measured rather than assumed: the engine's stealth reorders its TLS hello and masks the obvious flags, but it exposes no WebGL at all and its TLS hello carries no GREASE values, so a Cloudflare managed challenge held it in plain and stealth mode, through the plugin's CDP path and through the engine's own MCP (measured 2026-09-21). Report a challenge page to the user instead of retrying it; a real session cookie is the route that works, not a better fingerprint.
- The engine's MCP surface is wider than its CDP surface: `obscura mcp` ships 37 tools including cookies, storage state, tabs, screenshots, PDF, network requests and console messages, while the CDP probe finds only Page, DOM, DOMSnapshot and Runtime. Anything the CDP path cannot do may already exist one surface over.
- Browser tools share one queue: every browser operation runs through the supervisor's `engine.runExclusive` with the shared 30 second tool clock and the caller's abort signal, and no tool sends a CDP call around it.
- An element ref is only valid against the snapshot that produced it: resolve it through the fresh snapshot helper, and refuse a ref the current snapshot does not hold in plain words. Ref numbers are per page and are reused, so a ref is never compared across pages.

## Tooling

- Lint and format: Biome 2.x (biome.json: 2-space indent, line width 100, double quotes, no default exports except the pi entry point in src/index.ts). Run `npm run lint`, `npm run format`, or `npm run fix` to auto-apply.
- Pre commit: `scripts/git-hooks/pre-commit` runs lint, format, and typecheck on every commit (hooked via `core.hooksPath`, set by npm install). Fail with `npm run fix`, then re-commit.
- Testing gate: typecheck clean plus a real /check verify pass proves a feature; no test suite by default (Alpha).
- CI: none yet. The repo now has a remote, so a push based job can be added.

## Agent skills

- [obscura](.agents/skills/obscura/): h4ckf0r0day/obscura, the engine: process management, CDP domains, stealth, verification
- [pi-extension-authoring](.agents/skills/pi-extension-authoring/): romiluz13/pi-agent-skills, building pi extensions: ExtensionAPI, registerTool, UI hooks
Declined: pi-coding-agent, pi-package-authoring, typescript-advanced-types, nodejs-core

## Git

- integration: on (one branch per feature, PR driven)
- branch prefix: feat/
- commit: per-milestone
- remote: origin (github.com/Ralph-Abejuela/pi-obscura), reached through the `github_work` SSH alias with the ralph_id_ed25519 key, which prompts for its passphrase on every fetch and push, so run those in an interactive PTY. The default branch is `master`.

## Context files

<!-- Nested AGENTS.md files are listed here as they are created -->

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._