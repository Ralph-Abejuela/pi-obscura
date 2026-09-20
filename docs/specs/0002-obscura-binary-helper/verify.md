# Verify: Obscura binary helper · spec 0002 · updated 2026-09-20

_Steps derived from spec 0002 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## UI / manual

- [x] Probe with no binary at `~/.pi/agent/bin` (ran via `browser_probe` tool; same `probeEngine` core as `/browser-status`) → the message reads "The engine is not installed. Run `/browser-install`, or ask the agent to call `browser_install`." Eventual status line `no engine` · ran 2026-09-20 → AC-1
- [x] Run the install surface (`browser_install` tool; `/browser-install` command runs the same handler core) → install succeeded: version `obscura 0.2.2`, asset `obscura-x86_64-windows.zip`, destination `C:\Users\ExWaltzPC\.pi\agent\bin\obscura.exe`, verify pass. The reply's coverage check first hit a probe crash (engine `/json/protocol` has no `domains` array); fixed in `src/engine.ts` (`local: true`, commit `de7284b`), after which the probe reports all four domains → AC-2, AC-4, AC-8
- [x] Run `/browser-install` again with a binary present → the ask reported the path and version and asked for confirmation before overwriting; declining ended with "Install cancelled; nothing was downloaded or changed" (binary untouched, `obscura 0.2.2`) → AC-7
- [x] Have the agent call `browser_install` (tool surface) → a confirm prompt appeared before any download and the install proceeded after consent; the decline branch is covered by the print mode step below → AC-6
- [x] After the install, `~/.pi/agent/bin` holds `obscura.exe` (83,787,776 bytes) and no `.tmp-` folder remains → AC-4, AC-8
- [x] In print mode (`pi -p --no-session -e ./src/index.ts` calling `browser_install`) → "Install cancelled; nothing was downloaded or changed. I need an interactive pi session..." and nothing was downloaded → AC-6

## Commands

- [x] `npx tsc --noEmit` → exits 0 → build gate
- [x] `obscura.exe --version` at `~/.pi/agent/bin` → exit 0, output `obscura 0.2.2` matches `\d+\.\d+` → AC-5
- [x] Probe after install (ran via `browser_probe` in a fresh `pi -p` process, same `probeEngine` as `/browser-status`) → finds the binary at `~/.pi/agent/bin` first and reports engine ready with real domain coverage (Page, DOM, DOMSnapshot, Runtime all supported) → value sourcing row, AC-8
- [ ] With a binary present but made to fail (rename a broken file over `obscura.exe`), run the install → the verify failure message follows the Windows wording (antivirus hint) with a next step, and no partial binary remains → AC-5, AC-3
- [ ] Simulate an unsupported platform (patch the selection table to omit `win32:x64` on a throwaway copy) → the unsupported message names the platform and lists available targets, no network request is made → AC-9
- [ ] Kill the network mid download (or point the release URL at a truncated file) → the size mismatch message shows written and expected bytes, nothing in the destination, no `.tmp-` leftovers → AC-3
- [ ] Plant a hung tar (a fake `tar` first on PATH that sleeps) → the child is killed at 60 seconds, the install fails plainly, and a later install still works (the queue is not wedged) → AC-4 key invariant

## Acceptance-criteria coverage

- AC-1 → manual step 1
- AC-2 → manual step 2
- AC-3 → commands step (truncated download)
- AC-4 → manual step 2, commands step (hung tar)
- AC-5 → commands step (`--version`), commands step (broken binary)
- AC-6 → manual steps 4 and 6
- AC-7 → manual step 3
- AC-8 → manual step 2, commands step (`/browser-status` after install)
- AC-9 → commands step (unsupported platform)
- Value sourcing rows → asset table (step 2), Content-Length (AC-3 step), progress percent (step 2), destination constant (step 5), version output (commands `--version`), coverage from `probeEngine` (step 2), `findBinary` order (commands step after install)
