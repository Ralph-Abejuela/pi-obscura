# Obscura agent

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
- Tools use the browser_ prefix; src organizes into feature folders as slices land.
- Public APIs are documented: every exported symbol a tool or another module calls carries a short plain comment on what it does and when it fails.
- Strict TypeScript: tsconfig strict, no any.

## Tooling

- Lint and format: Biome 2.x (biome.json: 2-space indent, line width 100, double quotes, no default exports except the pi entry point in src/index.ts). Run `npm run lint`, `npm run format`, or `npm run fix` to auto-apply.
- Pre commit: `scripts/git-hooks/pre-commit` runs lint, format, and typecheck on every commit (hooked via `core.hooksPath`, set by npm install). Fail with `npm run fix`, then re-commit.
- Testing gate: typecheck clean plus a real /check verify pass proves a feature; no test suite by default (Alpha).
- CI: none yet, the repo has no remote. Add a push based job when a remote exists.

## Agent skills

- [obscura](.agents/skills/obscura/): h4ckf0r0day/obscura, the engine: process management, CDP domains, stealth, verification
- [pi-extension-authoring](.agents/skills/pi-extension-authoring/): romiluz13/pi-agent-skills, building pi extensions: ExtensionAPI, registerTool, UI hooks
Declined: pi-coding-agent, pi-package-authoring, typescript-advanced-types, nodejs-core

## Git

- integration: on (one branch per feature, PR driven)
- branch prefix: feat/
- commit: per-milestone

## Context files

<!-- Nested AGENTS.md files are listed here as they are created -->

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._