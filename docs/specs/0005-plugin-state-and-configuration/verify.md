# Verify: Plugin state & configuration · spec 0005 · updated 2026-09-21

_Steps derived from spec 0005 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Commands

- [x] `/browser-config` with no config file → every key shows its default as source, the engine line shows the status, stealth verdict runs on demand → AC-1
- [x] `/browser-config` with a file present → every key shows `(file)` where set, warnings list per key fallbacks → AC-1, AC-5
- [x] `/browser-config set port 99999` → refused with a plain message, the file byte for byte unchanged → AC-6
- [x] `/browser-config set stealth maybe` → refused, file unchanged → AC-6
- [x] `/browser-config set port` (no value) → the port override clears, report shows the new effective value → AC-6
- [x] `/browser-config set binaryPath C:\nonexistent\obscura.exe` → accepted with a warning (not refused); the next engine start fails naming that path and how to clear it → AC-6, AC-1
- [x] `/browser-config set` on a corrupt file → writes clean from the edit, the report says the unreadable content dropped → AC-6, AC-5

## Real engine

- [x] No config file: first `browser_probe` spawns on a free loopback port, reports defaults (stealth off, connect 10 s, spawn 30 s, grace 2 s), engine works → AC-1, AC-2
- [x] Config `{ "stealth": true, "port": 9333, "stopGraceMs": 3000 }`: probe reports an endpoint on `:9333` and stealth supported; the engine process command line carries `--port 9333 --stealth`; a stop is still clean → AC-1, AC-2, AC-3
- [x] Stealth capability source: two probes in one session run the `--help` check once (same verdict, no repeat), and a `/reload` clears the cache → AC-3
- [x] Corrupt JSON in the file: probe still works, reports "the config file could not be read" and the engine ran with defaults; fix the file and the next probe clears the warning → AC-5
- [x] Wrong type value, e.g. `stealth: "yes"`: probe warns naming the key, the engine still works → AC-5
- [x] Unknown key in the file: probe notes it is ignored → AC-5
- [x] Leftover engine: start `obscura serve` on 9222 by hand, then a session spawns on a different free port; both run, the old process is untouched → AC-2
- [ ] Busy pin: with the config pinning a port another process holds, the spawn error names the port and binary path and suggests clearing the pin → AC-2 (not exercisable on Windows: the engine dual binds the pinned port instead of failing; the named port and path error invariant was verified live via a different spawn failure)
- [x] Reload: run a session, `/reload`, first browser call works and uses the current file; a config change before the reload applies → AC-4

## Acceptance-criteria coverage

- AC-1 (one source, re read at every start, defaults otherwise) · covered by steps: Commands 1, 2; Real engine 1, 2, 9
- AC-2 (explicit port, free pick, leftover engine never blocks, never kill unowned) · covered by steps: Real engine 1, 2, 7, 8
- AC-3 (stealth gated by a per binary capability check, plain warning otherwise) · covered by steps: Real engine 2, 3
- AC-4 (reload re reads and builds a fresh machine) · covered by step: Real engine 9
- AC-5 (bad config falls back per key with a plain warning; never crashes) · covered by steps: Commands 3 to 7; Real engine 4, 5, 6
- AC-6 (/browser-config shows values with source and engine facts; set validates, refuses, reports) · covered by steps: Commands 1 to 7; Real engine 8