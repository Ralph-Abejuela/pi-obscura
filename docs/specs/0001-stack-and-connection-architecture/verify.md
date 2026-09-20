# Verify: Stack & architecture · spec 0001 · updated 2026-09-20
_Steps derived from spec 0001 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Commands
- [x] From the repo root, run `pi -e .` → the startup resources list shows the `src` extension entry and the status line shows `not started` → AC-1 (boots under `pi -e`)
- [x] Run `/browser-status` → a plain language engine report appears; the status flips to `no engine` when the binary is absent, or `engine ready` with the domain list when one is on PATH → AC-2
- [x] Run `/reload` → the reload completes, the `not started` status line reappears, and `/browser-status` still answers → AC-3 (reload leaves the session intact)
- [ ] With the Obscura binary on PATH, run `/browser-status` → the engine spawns, connects to the printed ws endpoint, and reports which of Page, DOM, DOMSnapshot, Runtime it implements → AC-4 (CDP coverage follow-up, needs the binary)

## Review-only
- [x] `waitForEndpoint` rejects inside 10 seconds when the engine prints no endpoint; the whole probe is bounded at 30 seconds → AC-5 (verified at runtime against fake engines: exit code 1, exit code 0, spawn failure, and a silent live engine that timed out at 10.5 s)

## Acceptance-criteria coverage
- AC-1 boot under `pi -e` · step 1
- AC-2 plain-language probe result · step 2
- AC-3 reload leaves the session intact · step 3
- AC-4 CDP domain coverage report (Page, DOM, DOMSnapshot, Runtime) · step 4
- AC-5 timeouts bound the probe · step 5