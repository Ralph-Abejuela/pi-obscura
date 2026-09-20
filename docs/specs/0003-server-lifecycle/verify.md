# Verify: Server lifecycle · spec 0003 · updated 2026-09-21

_Steps derived from spec 0003 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## UI / manual

- [x] Fresh session, engine not running → no `obscura.exe` in Task Manager; status line `browser: not started`. First `browser_probe` call → status moves through `starting` to `ready`; the reply names the binary and the supported domains; a second call answers instantly, same engine. → AC-1
- [x] Call `browser_probe`, then kill `obscura.exe` in Task Manager mid session → status line shows `down`; the next `browser_probe` call respawns and reports ready again, no user action. → AC-3
- [x] Kill the engine and dispatch several browser calls at once → exactly one restart: one new engine process, all calls settle (the build's print mode smoke proved `distinctPids=1` for a parallel trio). → AC-4
- [x] Single failed start then success: replace `obscura.exe` with a copy of `cmd.exe`, call twice → calls 1 and 2 fail plainly after the endpoint wait; restore the real binary, call again → spawns successfully, counter back to 0 (a single later failure does not trip broken). → AC-5 (counter reset)
- [x] Two failed starts: same broken binary, call three times → call 3 fails fast in milliseconds with the broken marker message naming `/reload`; restore the binary and `/reload` → first call spawns a fresh engine, marker cleared. → AC-5 (broken), AC-7
  - ran 2026-09-21: fake `cmd.exe` copy; attempts failed in 51ms and 25ms, attempt 3 failed in 0ms with the broken message. The literal `/reload` cannot be driven in print mode; a fresh instance (a new `pi -p` run, the same code path reload takes) spawned cleanly right after, which is the observable half of AC-7.
- [x] Leftover engine coexistence and never kill: keep an `obscura serve` from an earlier session on port 9222, then run the session's first browser call → the new engine starts and serves, the leftover process is untouched. → AC-6 (ran 2026-09-21: stale pid 19828 stayed alive after the run, the new engine bound the same endpoint and served)
- [ ] Defensive hint, code level: a spawn failure whose text matches a bind conflict carries the "process from an earlier session" hint and the check instruction (`STALE_PORT_PATTERN` plus the hint text in `src/supervisor.ts`). Obscura 0.2.2 never produces bind conflict text (it tolerates the shared port); a non CDP holder on the port instead hangs the CDP connect until the 30s spawn wrapper timeout. → AC-6 (defensive branch)
- [x] Quit pi cleanly (or `/reload`) → no `obscura.exe` remains after the session ends (build's run proved 0 left). → AC-2, AC-7

## Commands

- [x] `npx tsc --noEmit` → exits 0 → build gate
- [x] `Get-Process obscura` after a clean pi exit → nothing → AC-2

## Acceptance-criteria coverage

- AC-1 → manual 1 · AC-2 → manual 7, commands (`Get-Process`) · AC-3 → manual 2 · AC-4 → manual 3 · AC-5 → manual 4 and 5 · AC-6 → manual 6 · AC-7 → manual 5 and 7
- Note: the full "engine died, page state is gone" wording for an in flight call lands when slice 1 navigation tools (feature 6) hold post-ready CDP calls; this feature proves the observable part: death → `down` status → respawn on the next call.
- Value sourcing rows: lazy spawn decision (manual 1), status texts (manual 1, 2, 3), shared starting promise (manual 3), broken verdict + counter (manual 4, 5), stale engine coexistence + never kill (manual 6), defensive bind hint (manual 6, code check), clean stop and reload restart (manual 7)