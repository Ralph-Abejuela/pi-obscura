# 0003. Server lifecycle for the Obscura pi plugin

**Date**: 2026-09-21
**Status**: Accepted

## Summary

This spec decides how the plugin supervises the Obscura engine process over a whole pi session. The engine spawns lazily on the first browser tool call, stays alive across calls, shows its state in the pi status line, and stops cleanly when the session ends or the plugin reloads. When the engine dies mid session, the failing tool call answers in plain words and the next call respawns the engine; there is no automatic backoff supervisor, because page state is lost on death anyway and a crash loop is caught by a fail fast marker after two consecutive failed starts. The current probe in `engine.ts` spawns a fresh engine per check and tears it down, so this spec replaces that with one persistent, supervised engine per session. A leftover engine from an earlier session cannot wedge the engine port: Obscura tolerates a shared loopback bind, so the plugin never needs to kill another process, and the stale port hint from the original AC-6 was reconciled to a defensive branch on 2026-09-21.

## Requirements

**User stories**:
- As the agent, I want the browser tools to always find a live engine behind them, so I never manage processes myself.
- As the agent, I want to know plainly when the engine died and what I lost, so I can decide the next step instead of guessing why a call failed.
- As the user, I want the browser process gone when my pi session ends, so no orphan keeps running on my machine.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):

- **AC-1**: No engine process runs before the first browser tool call; that call spawns it, the status line moves through starting to ready, and the call proceeds only once the engine is ready.
- **AC-2**: On session shutdown the engine stops cleanly (a grace period, then a hard kill if it lingers) and no engine process the plugin spawned survives a clean close.
- **AC-3**: When the engine dies mid session, the in flight tool call fails with a plain message naming the death and the consequence (page state is gone), and the next browser tool call respawns the engine and proceeds without any user action.
- **AC-4**: When several tool calls are queued at the moment of a death, exactly one restart happens; the first call owns it and the rest run after the engine is ready again, never a storm of parallel respawns.
- **AC-5**: Two consecutive failed spawn attempts mark the engine broken; later tool calls fail fast in plain words, they do not wait the endpoint timeout again; a successful spawn resets the counter, and the broken marker clears when the plugin reloads or pi restarts.
- **AC-6**: The plugin never kills an engine process it did not spawn; a leftover engine from an earlier session on the same loopback port does not break the current session (the new engine still starts and serves). Defensive branch: if a spawn failure ever shows bind conflict text, the error names a process from an earlier session as a possible cause and how to check it.
- **AC-7**: A pi hot reload stops the engine; the first browser tool call after the reload spawns a fresh one.

## Decision

**Chosen option**: Option 1, fail the call and restart on demand. The engine is supervised through a small state machine, not a backoff supervisor.

The plugin keeps one persistent engine per extension instance, started lazily on first use. Death is detected by the process exit listener and the WebSocket close handler (settled in spec 0001). The call that hits a dead engine fails in plain words; every browser tool call runs an ensure step at the front of the shared queue, which spawns a missing engine, waits on an in flight spawn, or fails fast when the engine is marked broken. A broken marker trips after two consecutive failed starts. Stop is grace then hard kill, on session shutdown and on reload.

**Implementation skills**: `obscura` (`h4ckf0r0day/obscura`, `.agents/skills/obscura/`) · `pi-extension-authoring` (`romiluz13/pi-agent-skills`, `.agents/skills/pi-extension-authoring/`)

## Feature design

**Data model sketch**: no database. The module state of the engine supervisor, held in memory for the life of the extension instance:

- `engineState.phase`: `stopped` | `starting` | `ready` | `dead`
- `engineState.child`: the spawned process (present in starting and ready, null in stopped and dead)  
- `engineState.client`: the open CDP client (present only in ready)
- `engineState.endpoint`: the ws endpoint the engine printed (present in ready)
- `engineState.startingPromise`: the in flight spawn promise (present only in starting, so queued callers await the same spawn)
- `engineState.consecutiveFailures`: integer, increments on every failed spawn, resets to 0 on a successful start
- `broken` is derived: `phase === dead` and `consecutiveFailures >= 2`

**State transitions**:

- `stopped` → `starting`: first browser tool call, or any call after a death or a reload
- `starting` → `ready`: endpoint line printed and CDP connection open
- `starting` → `dead`: spawn error event, endpoint timeout, or exit before ready; `consecutiveFailures` increments
- `ready` → `dead`: engine exit event or WebSocket close; does not increment the counter (a runtime death is a normal event, handled by restart on next call)
- `dead` → `starting`: next tool call, unless broken
- `dead` → `stopped`: broken; stays stopped until a reload or pi restart clears module memory
- `stopped` / `starting` / `ready` / `dead` → `stopped`: session shutdown or module reload, which kills the child (grace then hard kill) and closes the client

**API surface**: no new browser tools; the surface is internal to the extension and threaded through the existing queue from spec 0001. Every browser tool calls `ensureEngine()` before its CDP work.

| Function | Key inputs | Key outputs | Key errors |
|---|---|---|---|
| `ensureEngine()` | none | `EngineHandle` (child + client) when ready | plain error: engine died, page state lost, restart on next call (broken: failed fast, reload or restart pi) |
| `stopEngine(reason)` | reason: shutdown \| reload | none | none (kill failures are logged, not raised) |
| `statusLine()` | none | `browser: starting` \| `browser: ready` \| `browser: down` | none |

The existing `probeEngine()` path stays untouched: feature 4 (binary helper) uses it to verify an install, and it deliberately spawns a throwaway engine per check.

**Value sourcing** (every value the ACs need an action to produce, and where it comes from):

| Action | Value produced / displayed | Source |
|---|---|---|
| Lazy spawn (AC-1) | the decision to spawn | `ensureEngine` runs when `phase === stopped` at the front of the queue |
| Status line starting / ready / down (AC-1, AC-3) | the current state text | derived from `engineState.phase` at each transition |
| Death message (AC-3) | "the engine died, the page state is gone, the next browser call restarts it" | static text decided in this spec, triggered by the exit event or WS close |
| Wait, do not spawn twice (AC-4) | sharing one spawn | `engineState.startingPromise`, awaited by every queued caller while `phase === starting` |
| Broken verdict (AC-5) | fail fast instead of a spawn attempt | derived from `consecutiveFailures >= 2` |
| Counter reset (AC-5) | 0 again | the moment a spawn reaches `ready` |
| Stale port hint (AC-6) | "a process from an earlier session may hold the port" plus the check instruction | appended only when a spawn failure's error text matches a bind conflict (defensive branch: obscura 0.2.2 never produces that text, verified 2026-09-21); the never kill rule and stale engine coexistence are the observable parts |
| Restart after reload (AC-7) | a fresh engine on the next call | `stopEngine(reload)` on module reload sets `stopped`, so the next ensure spawns |

**Key invariants**:
- At most one engine process per extension instance.
- At most one spawn in flight at a time; the queue front owns it.
- No engine process the plugin spawned survives a clean shutdown.
- The plugin never kills a process it did not spawn.
- A leftover engine from an earlier session may share the loopback port; the plugin leaves it alone and its own engine still starts and serves.
- `consecutiveFailures` resets to 0 only when a start reaches `ready`.

**Security model**: the engine binds the loopback interface (127.0.0.1) and carries no authentication surface beyond the local CDP endpoint; the extension runs inside the pi process under the user's account. No new trust boundary, no regulated data, no role model.

**Configuration required**: no new environment variables or credentials. Timeout constants exist in code for now: endpoint wait default 10 seconds (from spec 0001), spawn wrapper timeout 30 seconds, stop grace period 2 seconds. Feature 3 (plugin state and configuration) later owns these as config values; this spec fixes only the defaults.

**Critical test scenarios**:
- Happy path: open a session, call a browser tool, engine spawns lazily, status line shows starting then ready, a second call reuses the same engine, session end leaves no process. Verifies **AC-1**, **AC-2**.
- Failure case: kill the engine process from outside mid session; the in flight call fails with the plain death message, the next call respawns and navigates a blank engine. Verifies **AC-3**.
- Failure case: point the binary at a broken engine (or a path that fails to start) and call twice; the third call fails fast without waiting the timeout. Verifies **AC-5**.
- Concurrency: dispatch several browser calls in parallel, kill the engine mid flight; exactly one restart happens and all calls settle. Verifies **AC-4**.
- Restart behavior: after a death and restart, the new engine has no page; the agent re reads. Verifies **AC-3**.
- Recovery: trigger a /reload while the engine is marked broken; the first call after reload spawns a fresh engine. Verifies **AC-5**, **AC-7**.
- Stale engine case: keep `obscura serve` from an earlier session running on the same port, then run the current session's first browser call; the new engine starts and serves, the leftover process is untouched, and no bind conflict failure occurs. Verifies **AC-6**.

## Build plan

Ordered for the Tracer Bullet approach: the thinnest end to end thread first (one persistent, supervised engine serving a tool call), then each hardening pass. Engine code replaces the per probe spawn in `engine.ts`; the probe itself stays for feature 4.

1. Persistent supervised engine: a module that spawns once on first ensure, reuses the process and CDP client across calls, and tears down on module shutdown. Replace the probe per call path in `engine.ts` with it. Satisfies **AC-1**.
2. Lazy start and status line: spawn on first browser tool call only; drive `browser: starting` → `browser: ready` → `browser: down` through `ctx.ui.setStatus` at transitions. Satisfies **AC-1**, **AC-3**.
3. Death detection and restart on next use: the exit listener and WS close mark `dead`; the in flight call fails with the plain message; the next call's ensure respawns. Satisfies **AC-3**.
4. Queue ownership: route every browser tool through `ensureEngine()` at the front of the existing queue; while `phase === starting`, await the shared starting promise instead of spawning again. Satisfies **AC-4**.
5. Crash loop guard: count consecutive failed spawns, mark broken at two, and fail fast in later calls with a plain message; clear on reload or pi restart. Satisfies **AC-5**.
6. Clean stop: on `session_shutdown` and on module reload, stop the engine grace then hard kill (2 second grace), clear the status line, and verify no spawned process survives. Satisfies **AC-2**, **AC-7**.
7. Stale port report: on a spawn failure whose error matches a busy bind, append the stale engine hint and the check instruction; never kill an unowned process. The hint is a defensive branch: obscura 0.2.2 tolerates the shared port and never prints bind conflict text (verified 2026-09-21), so it fires only for an unusual holder or a future engine release. Satisfies **AC-6**.

## Consequences

**Positive**:
- One engine per session instead of one per probe; browsing sessions stop paying a fresh cold start per call.
- A dead engine never hangs a call: it fails fast in plain words, and the next call recovers without the user doing anything.
- A broken binary fails in milliseconds after the two attempt gate, not ten seconds per call forever.
- No backoff supervisor to tune or debug; the state machine is the whole lifecycle.

**Negative / tradeoffs**:
- Every death loses the page; the agent must re read. State restoration was declined, so this is an accepted cost of the blank restart choice.
- A binary that fails to start is unrecoverable within the session; the repair lever is a reload or a pi restart, which is coarse.
- A runtime crash loop (dies after ready, so it never trips the spawn counter) is not caught by the fail fast marker; each call pays one restart. Rare for a browser engine; the endpoint timeout still bounds each attempt.
- A leftover engine from a hard killed session can keep running on the same loopback port. Obscura 0.2.2 tolerates the duplicate bind, so the stale hint is a defensive branch its real failure modes never trigger. The premise was reconciled on 2026-09-21 after /check verify showed a stale engine never blocks a new spawn (the original AC-6 assumed it did).
- With two engines on the same port, which process answers a CDP connection is chosen by the operating system, not the plugin. Sessions still work (verified), but an explicit per session port removes the ambiguity; see Follow-up.

**Neutral**:
- `engine.ts` changes shape: today's probe per call becomes the persistent supervisor, and the probe path stays only for feature 4's install verification.
- The scope row wording for feature 5 changes from "the engine starts with the session" to "starts on first use".

## Follow-up

- [ ] Timeout constants fixed here (endpoint wait, grace period) become feature 3 configuration when plugin state and configuration lands.
- [ ] Explicit engine port: when feature 3 (plugin state and configuration) lands, have the plugin pick a free port and spawn `obscura serve --port <n>` explicitly, removing the duplicate bind ambiguity with a leftover engine (reconciled 2026-09-21).
- [ ] The AC-6 stale port premise was reconciled in place on 2026-09-21: obscura 0.2.2 tolerates the shared loopback bind, so the hint stays as a defensive branch for bind conflict text that this engine never produces.
- [ ] Root `AGENTS.md` still does not exist; /audit (feature 2, coding standards and tooling) should record the `obscura` and `pi-extension-authoring` skills in its `## Agent skills` section (carried from spec 0001).
- [ ] The `obscura` skill notes `serve` is the spawn subcommand and the endpoint binds 127.0.0.1; if a future engine release changes the bind, the security model note in this spec needs a revisit.

## Rationale

Reasoning, options, and the full decision record: see [rationale.md](rationale.md).