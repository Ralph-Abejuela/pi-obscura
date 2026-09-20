# Verify: Obscura binary helper · spec 0002 · updated 2026-09-20

_Steps derived from spec 0002 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## UI / manual

- [ ] Run `/browser-status` with no binary at `~/.pi/agent/bin` → the message reads "The engine is not installed. Run `/browser-install`, or ask the agent to call `browser_install`." and the status line shows `no engine` → AC-1
- [ ] Run `/browser-install` → the download starts without a consent prompt (typing the command is the consent), progress percent shows on the status line, and the reply reports the installed version, asset name (`obscura-x86_64-windows.zip` on this machine), destination path, verify result, and the Page/DOM/DOMSnapshot/Runtime coverage → AC-2, AC-4, AC-8
- [ ] Run `/browser-install` again with a binary present → the ask reports the path and version and requires confirmation before overwriting; declining ends with "Install cancelled; nothing was downloaded or changed." → AC-7
- [ ] Have the agent call `browser_install` → a confirm prompt appears before any download; declining ends with the same cancelled message and nothing was downloaded → AC-6
- [ ] After a successful install, check `~/.pi/agent/bin`: `obscura.exe` exists, no `.tmp-` folder remains, and the reply ends with the CDP coverage report → AC-4, AC-8
- [ ] In print mode (`pi -p`), calling `browser_install` → declined with a plain message, nothing downloaded → AC-6

## Commands

- [ ] `npx tsc --noEmit` → exits 0 → build gate
- [ ] `obscura.exe --version` at `~/.pi/agent/bin` → exit 0, output matches `\d+\.\d+` → AC-5
- [ ] `/browser-status` after install → the probe finds the binary in `~/.pi/agent/bin` first (value sourcing: `findBinary` search order) and reports engine ready with the real domain coverage → value sourcing row
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
