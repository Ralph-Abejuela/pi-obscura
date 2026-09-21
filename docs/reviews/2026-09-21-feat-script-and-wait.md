# Review, feat/script-and-wait, 2026-09-21

**Reviewed by**: fresh-model reviewer (author on a prior model, feature 8 delta only)
**Scope**: 5 code files (`src/script.ts` new, plus edits to `src/index.ts`, `src/browser.ts`, `src/interact.ts`, and new `scripts/script-selfcheck.ts`), branch vs base 8d67039 (stacked on unmerged feat/interaction-tools; feature 7 read as context only)
**Verdict**: Blocked

## Summary

The change adds `browser_eval` and `browser_wait` per spec 0007, with honest degraded-value reporting, plain error text, and a queue-holding poll loop. The core eval path is well built: the AC-12 `outstanding` flag is correctly guarded against false death verdicts, and the self check is unusually strong. But the spec's flagship safety property — a wedged page script is recovered by an engine restart — is implemented on only one narrow path. `browser_wait` never raises the AC-12 death verdict at all, and `browser_eval`'s post-evaluation `pageInfo` read runs outside any clock, so both leave uncancellable hangs or a permanently wedged engine on paths the spec explicitly claims are covered.

## Blockers

### 🔴 `browser_wait` never raises the AC-12 engine-down verdict — `src/script.ts:403-465`

**Problem**: AC-12 says "an eval **or wait** call whose page evaluation was still outstanding when the tool clock expired treats the engine as down", and the spec invariant for condition mode claims it carries "the same interpreter path, the same clock, and the same recovery". `waitForMatch` has none of the `outstanding` tracking `evalInPage` has: a poll evaluation that never returns (e.g. `condition: "while(true){}"`) or a final `snapshotRefs` that hangs leaves the outer `runOp` clock to fire into the generic mapper ("the wait timed out. The page may still be loading…"), with no `markEngineDown`. Confirmed in `src/supervisor.ts:508-524`: the only runtime death triggers are the exit/disconnect events and `isEngineDown(error)` in `runExclusive`; a wedged engine with a live process matches neither.

**Why it matters**: the engine stays marked "ready" while permanently wedged. Every subsequent browser call burns its full 30-second clock, times out with a misleading "page may still be loading" message, and recovers nothing — the session is bricked until `/reload`, which is exactly the failure AC-12 exists to prevent. Aborting frees the caller but not the engine.

**Suggested fix**: apply the same pattern as `evalInPage`: track whether a page evaluation (a tick's `pollOnce`, the final snapshot) was still outstanding when `runOp` rejected with the clock, and raise `alreadyClassified(..., true)` on that path. The wait never sets `await`, so no exemption is needed.

### 🔴 `pageInfo` after the eval runs outside the tool clock — unbounded, unabortable — `src/script.ts:295`

**Problem**: `evalInPage` awaits `runOp(...)` (clocked, abortable) and then calls `await pageInfo(handle)` — a raw `send` (`src/browser.ts:73-86` has no internal timeout) with no `runOp`, no abort race, and the queue still held. A page script that returns its value and then wedges the engine (trivially: `setTimeout(() => { while (true) {} }, 0)`) hangs this call forever; the caller's abort signal does nothing because nothing races it.

**Why it matters**: violates AC-11's explicit "No eval or wait hangs: the 30 second tool clock and the caller's abort signal bound every call", and produces a strictly worse outcome than the wedged-eval case the feature designed a recovery for: an uncancellable tool call instead of a 30-second error plus a respawn.

**Suggested fix**: move the `pageInfo` read inside the `runOp` body (it is part of the same result; the 5-second wait reserve shows the budget exists), or wrap it in its own bounded op.

## Major

### 🟠 Abort with an outstanding page evaluation leaves a possibly wedged engine unmarked — `src/script.ts:299-320`

**Problem**: if the caller aborts while `evaluateOnce` is in flight, `bounded` rejects with `CANCELLED_MESSAGE`; the outer catch rethrows it (`timedOut` is false), no death verdict is raised. But per the feature's own probe record, aborting does not stop page JavaScript: if the script was a wedge, the engine is dead-but-marked-ready with the same consequences as the blocker above.

**Why it matters**: the AC-12 reasoning ("nothing outside the page can stop page JavaScript") applies to the abort signal exactly as to the tool clock, but only the clock path implements it.

**Suggested fix**: in the cancelled-with-`outstanding` case, either raise the death verdict too (conservative, costs page state on a merely slow script) or at minimum say in the cancellation message that the page script may still be running and a wedged engine needs the next call observed.

### 🟠 Wait deadline is measured from before the queue, silently shortening the wait — `src/script.ts:411-415`

**Problem**: `started` is captured before `runOp` is entered, but the tool clock inside `bounded` starts only after the queue and any engine spawn. A wait issued while a slow call (a large `browser_read`, a screenshot) is in flight has its deadline already consumed by the queue time: with 10+ seconds of queueing, the wait polls once and immediately reports `appeared: false` even though its own `timeoutMs` had not elapsed, and `elapsedMs` reports queue time as wait time.

**Why it matters**: the wait's core contract is "synchronize with changing content instead of reading too early"; the common pattern of issuing a read and a wait together produces a premature, wrong verdict with no note. AC-7's deadline is defined on the wait's own clock, which does not start until polling does.

**Suggested fix**: capture `started` inside the `runOp` body (first line of the poll loop), which also aligns it with the tool clock the reserve is computed against.

## Minor

### 🟡 Tautological assertion in the self check — `scripts/script-selfcheck.ts:354`

`assert.ok(afterNav.refs.length >= 0, "the verdict still carries the refs contract")` is always true and proves nothing. Assert `> 0` plus at least one known ref text from the MOVED fixture, or drop the line.

### 🟡 Eval ref path reimplements the shared action helper — `src/script.ts:218-241`

`evaluateOnce`'s ref path duplicates `snapshotRefs` → `findFreshRef` → `objectForNode` → `callFunctionOn` from `src/interact.ts`, forking only because `callFnOn` hardcodes `awaitPromise: true`. The spec sanctions the fork, but the smaller diff was one parameter (`awaitPromise`) on the shared helper; as written, the two call sites can drift (spec 0007's own follow-up notes spec 0006's `callFnOn` already reads the wrong error shape). Parameterize on the next touch.

### 🟡 Status line is written before the queue is taken and mislabels a refused wait — `src/index.ts:668-670`, `src/index.ts:45-52`

The pre-queue `setStatus("browser", "waiting for X")` shows "waiting" while the call is actually queued behind another operation, and `watchingLabel` duplicates `resolveMode`'s first-given-wins pick — on a two-mode refusal the status names only the first mode before the finally restores it. Restore-on-every-exit-path is otherwise correct (the `finally` covers refusals thrown before `runOp`).

## Nits

- ⚪ `src/script.ts:367-369`, the `text` poll uses `document.body.innerText`, so on a body-less document the poll throws a TypeError that the tick loop reads as a fatal page error rather than "no match yet"; `document.documentElement` or a guarded expression would be sturdier.
- ⚪ `scripts/script-selfcheck.ts`, the three-consecutive-failed-ticks bail-out path is never exercised (the navigation test covers the retry-success side); a second navigation landing on a page that never matches would prove the give-up message too.

## Strengths

- The `outstanding` flag in `evalInPage` is subtly correct: because the `finally` clears it only when the evaluation settles, page-error messages that happen to contain "timed out" or "did not settle" cannot produce a false death verdict, and the awaited-promise exemption lands on both race outcomes of the two 30-second clocks.
- The self check is genuinely strong for a no-runner project: the literal-concatenation fixtures defeat the engine's innerText-equals-textContent trap, timing assertions prove the abort and first-tick-refusal paths actually stop early, and the queue-discipline test measures the read's start time against the wait rather than trusting ordering.
- Degraded-value reporting (`_nid` elements, `{}` Promise/Map/Set, the null ambiguity, the truncation note naming how much was dropped) matches the probe record exactly and is honest instead of clever.

## Test coverage

None-by-design per AGENTS.md (typecheck + `/check verify` gate); no missing-suite findings raised. The self check covers AC-1 through AC-11's happy paths and refusals well. The 30-second cases (unsettled await, wedge recovery) are explicitly delegated to `/check verify` — which is precisely why the two blockers above matter: the wait's wedge path would have been caught by that checklist ("a condition that wedges → next call respawns"), and the unclocked `pageInfo` hang only shows up on a page that wedges *after* returning its value. `/check verify` should add that case explicitly.
