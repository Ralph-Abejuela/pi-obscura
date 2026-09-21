# 0007. Script and wait tools

**Date**: 2026-09-21
**Status**: In Progress

## Summary

Two new tools complete the working surface: `browser_eval` runs the agent's own JavaScript in the page, and `browser_wait` pauses until text, an element, or a condition appears. The wait polls through the one queue the whole plugin is built on, so a wait holds every other browser call until it ends, and it reports its own verdict rather than a generic timeout. The design follows what the engine actually does (probe verified): an awaited promise is bounded by the engine at 30 seconds, a page script can wedge the engine for good, and this engine has no way to test whether text is visible.

## Requirements

**User stories**:
- As the agent, I want to run my own JavaScript in the page, so I can read what the markdown read does not surface (a JSON blob, a computed value, an app's own state) and ask a page's own code what it thinks.
- As the agent, I want to pause until text, an element, or a condition appears, so I can synchronize with changing content instead of reading too early or guessing a sleep.
- As the agent, I want a wait that says plainly when nothing appeared and hands me fresh element references anyway, so I can decide the next step without a second call.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):

- **AC-1**: `browser_eval` runs the expression as a script in the page: a plain expression, a statement list, or a script works, and the script's completion value is reported (probe verified: `const a = 1; a + 1` gives 2, `if (true) { 5 }` gives 5). The result reports the value and its JavaScript type, capped at a code constant with a plain truncation note. A value the engine could not serialise (a DOM element, a Promise, a Map, a Set, a cyclic object) is reported as such in plain words, never by printing the engine's own serialisation of it. A cyclic object and `window` are not covered by that guard: this engine turns both into the ordinary string `[object Object]`, so the tool reports the string it actually got.
- **AC-2**: `browser_eval` takes an optional ref. With a ref, the expression runs as the body of a function called with that element as `this`, so a value needs `return`; the ref is resolved against the snapshot taken at the start of the call, and a ref the current snapshot does not hold is refused in plain words (the spec 0006 freshness rule). Without a ref, the expression is a script and its completion value comes back.
- **AC-3**: `browser_eval` takes an optional `await` flag, off by default. With `await: true` a promise result is awaited, bounded by the engine's own 30 second promise bound (probe verified on both evaluator paths, which report distinct messages), and a promise that never settles is reported in plain words naming that bound. The plugin's own clock starts first and is the same length, so the plugin's message is usually the one that reaches the caller, and it names the promise case. With `await` off, a promise result reads as the empty object the engine serialises it to, and the message names `await: true` as the fix.
- **AC-4**: a page script that throws is a plain tool error naming the page's own message and the first stack line in whichever shape the engine uses: `Runtime.evaluate` reports it in the response's exception details, while the ref path's `Runtime.callFunctionOn` raises it as a CDP protocol error of the form `JS error: <page message>` (probe verified, including a syntax error). The session stays usable: the next browser call works.
- **AC-5**: `browser_wait` takes exactly one of `text`, `selector`, or `condition`, plus an optional `timeoutMs`. Zero modes or two at once is refused in plain words naming the three modes, the same rule `browser_scroll` already uses for `ref` and `by`.
- **AC-6**: `text` matches a literal case sensitive substring of the page's text; `selector` matches the presence of an element for a CSS selector; `condition` matches a truthy completion value of the caller's own JavaScript expression. The result says which mode it used and what it looked for. The engine's limits are stated where they bite: a text match is text anywhere in the document, not text a person can see (probe verified: this engine's `innerText` equals `textContent`, so hidden, offscreen, script, and style text all count), and an invalid selector returns null on this engine rather than throwing, so a mistyped selector reads as no match and the timeout message names the selector.
- **AC-7**: the wait polls every 100 ms (a code constant), has its own 10 second default clock, accepts up to 25 seconds, and clamps anything outside 500 ms to 25 seconds with a note naming the clamp. The poll loop's deadline is the smaller of the wait's own clock and the 30 second tool clock minus a 5 second reserve, so the final snapshot, the page info read, and the queue release fit inside the tool clock and the wait reports its own verdict rather than the generic timeout.
- **AC-8**: a wait that runs out of time is a normal result, not an error: `appeared: false`, how long it waited, which mode and value it watched, where the page is now (URL and title), the fresh refs, and a next step. A wait that matches reports `appeared: true` with the same fields.
- **AC-9**: every wait result carries fresh refs from a snapshot taken when the wait ends, on both the matched and the not matched path, plus the page's URL and title at that moment. No ref field is added to the ref contract: the wait carries the refs `browser_read` already produces.
- **AC-10**: while a wait is polling it holds the one supervisor queue for its whole duration, so no other browser call interleaves and a concurrent call runs afterwards; the pi status line names what the wait is watching, and the queue is released the moment the wait ends, including when the caller's abort signal fires: the poll loop checks the abort signal every tick and races its sleep against it, so an aborted wait stops evaluating at once. The status line returns to the engine's own state text when the wait ends, on both exit paths.
- **AC-11**: every bailout is plain text on the tool result: a condition that throws (refused at the first tick, never after the timeout), a transport or context error on a tick (a page navigating mid wait) that is retried instead of being read as a broken condition, up to three consecutive failed ticks, a refused mode combination, an out of range timeout, a stale ref, an unserialisable value, engine down, and the tool clock. No eval or wait hangs: the 30 second tool clock and the caller's abort signal bound every call, carried from spec 0004.
- **AC-12**: an eval or wait call whose page evaluation was still outstanding when the tool clock expired treats the engine as down, so the next browser call starts a fresh engine, and the message says the page script may still be running. An awaited call is exempt, because the engine's own 30 second bound is exactly that case and probe verified the session recovers by itself, and so is a timeout after the wait's poll loop has already finished, where no page evaluation is outstanding. This is what makes an uninterruptible page loop recoverable: probe verified, `while (true) {}` blocks the engine for good (45 seconds of polling got no answer and no rejection, with the process alive), and nothing outside the page can interrupt page JavaScript.
- **AC-13**: proven by the self check against `data:` URLs (the engine refuses loopback fixtures): an evaluation of a plain value, a statement script, and an element by ref; a wait on text that appears late, on a selector, and on a condition; a wait that times out and reports `appeared: false`; a condition that throws; a wait aborted mid poll that stops polling and frees the queue; a navigation mid wait that the retry policy absorbs; refs fresh after every wait; and a read issued while a wait is polling that completes only after the wait ends.

## Decision

**Chosen option**: Option 1: a script evaluator with an explicit await flag and an optional ref, plus a one mode polling wait that holds the one queue and reports its own verdict.

One line: `browser_eval` returns the script's completion value typed and capped, guards the values this engine degrades (an element, a Promise, a Map), awaits only when asked, and runs against a fresh ref when given one; `browser_wait` polls exactly one of text, selector, or condition every 100 ms under a 10 second default clock capped at 25 seconds, holds the one queue while it polls with the status line naming it, and hands back `appeared` plus fresh refs whether or not it matched.

**Implementation skills**: `obscura` (`h4ckf0r0day/obscura`, `.agents/skills/obscura/`) · `pi-extension-authoring` (`romiluz13/pi-agent-skills`, `.agents/skills/pi-extension-authoring/`)

## Feature design

**Data model sketch**: no database and no persistence. Nothing about an expression or a wait is stored: both run against the live page and report a result. The ref contract from spec 0004, as extended by spec 0006, is reused unchanged: the eval ref path resolves a ref through a fresh snapshot, the same helper the action tools use, and the wait result carries the refs `browser_read` produces. The one new named shape is the eval result payload (the value, its type label, a truncated flag, the URL and title), which is a tool result, not stored state.

**State transitions**: not applicable. The engine lifecycle (starting, ready, dead) is spec 0003's state machine. This spec adds one transition to it: an eval or wait call that hits the tool clock is a death trigger, so the plugin moves the engine to dead and the next call spawns a fresh one (AC-12). That is the fourth trigger beside the child exit event, the CDP socket close, and a transport failure on an in flight call.

**API surface**: two pi tools, no auth (the caller is the pi agent inside the pi process, the same trust as shell tools, carried from spec 0004). Both run through `engine.runExclusive` and the error mapper with its four plain categories.

| Tool | Key inputs | Key outputs | Key errors |
| --- | --- | --- | --- |
| `browser_eval` | `expression: string` (required); `ref: number` (optional, runs the expression as a function body with the element as `this`, so a value needs `return`); `await: boolean` (optional, default false) | the value with its type label, a truncated flag, the URL and title | a page script that threw (message plus first stack line, read from the exception details or from the `JS error:` protocol shape), a ref the fresh snapshot no longer holds, a degraded value (reported, not refused), the engine's unsettled promise bound, engine down, timeout |
| `browser_wait` | exactly one of `text: string`, `selector: string`, `condition: string` (required); `timeoutMs: number` (optional, 500 to 25000, default 10000) | `appeared` (boolean), the mode, what it watched, the elapsed time, the URL and title, fresh refs | zero or two modes, an out of range timeout, a condition that threw, a condition that never ran, engine down, timeout |

**Value sourcing** (every value each tool produces, computes, or displays, and where it comes from):

| Action | Value produced / displayed | Source |
| --- | --- | --- |
| eval | the value | the `Runtime.evaluate` result's `value` field (probe verified: present for plain data when `returnByValue` is on), serialised to JSON text and capped at a code constant |
| eval | the type label | the same payload's `type`, `subtype`, and `className` (probe verified: `subtype: null` for undefined, null, and NaN alike; `className: Object` for a Promise and for an element with `returnByValue` on) |
| eval | the degraded value note | derived from the serialised value: an object carrying `_nid` is an element (probe verified: an element serialises to `_nid` plus hundreds of computed style keys), and an empty object is reported as the empty object it is, with the Promise, Map, and Set hint rather than a claim about which one it was (probe verified: all three serialise to `{}`) |
| eval | the null ambiguity note | the payload's `subtype` being `null` (probe verified: undefined, null, and NaN are indistinguishable) |
| eval | the awaited value | the `await` input plus the engine's own 30 second promise bound (probe verified: a never settling promise is rejected by the engine with "did not settle within 30000ms") |
| eval | the element for a ref | the fresh snapshot's backend node id through `DOM.resolveNode`, the same path the action tools use (spec 0006) and `Runtime.callFunctionOn` for the body |
| eval | the URL and title | the spec 0004 `pageInfo` read after the evaluation |
| eval (ref form) | the page's error message | the CDP protocol error text `JS error: <page message>` plus a stack, trimmed to the message and the first stack line (probe verified) |
| eval (ref form) | the awaited value | the `await` input through `Runtime.callFunctionOn` with `awaitPromise`, bounded by the engine's own 30 second bound on this path too (probe verified) |
| wait | the match verdict | one poll expression per tick: plugin authored for `text` and `selector`, caller authored for `condition`, its completion value read for truthiness |
| wait | the `text` poll expression | `document.body.innerText.indexOf(<the literal>) >= 0`, a plugin owned constant expression (probe verified: `innerText` here equals `textContent`, so hidden, offscreen, script, and style text all count) |
| wait | the `selector` poll expression | `document.querySelector(<the literal>) !== null`, a plugin owned constant expression (probe verified: an invalid selector returns null, no exception) |
| wait | the elapsed time | the wall clock at the end of the poll loop minus the start |
| wait | the wait's own bound | the `timeoutMs` input, defaulted by a code constant and clamped to the code constant range |
| wait | the poll interval | a code constant, 100 ms |
| wait | fresh refs | `DOMSnapshot.captureSnapshot` plus the read serializer walk, the same call `browser_read` makes (spec 0004) |
| wait | the URL and title | the spec 0004 `pageInfo` read |
| wait | the clamp note | the `timeoutMs` input against the code constant range |
| both | the timeout verdict | the 30 second tool clock, a code constant (spec 0004) |
| both | the engine down verdict on a timeout | derived: page evaluation was still outstanding at the clock and the call was not awaiting a promise; raised as one error already marked classified and already marked engine down, so the error mapper passes it through and the queue acts on it (AC-12) |
| wait | the poll deadline | the smaller of the `timeoutMs` input and the tool clock minus the reserve code constant |
| wait | the tick verdict | the poll response: a page script error fails fast, a transport or context error is retried up to three consecutive times |
| wait | the status line text | the wait tool's own write for the duration, restored from the supervisor's own state text when the wait ends |
| both | the engine down verdict | the supervisor state machine, spec 0003 |

**Key invariants**:
- Eval and wait are the only two tools that run caller authored JavaScript in the page; no other tool can wedge the engine, so the recovery rule lives on these two paths and not in the shared error mapper.
- All CDP work runs through the one queue; a wait holds it for its whole duration and never interleaves (spec 0001 and spec 0004, rechecked here).
- The engine bounds an awaited promise at 30 seconds and answers **no other evaluation** while it waits (probe verified: 30 one second polls during an unsettled await all expired, and the session answered again at 30007 ms). A synchronous loop has no bound at all (probe verified).
- This engine has no visibility model, so the wait never claims one: `innerText` equals `textContent`, `checkVisibility()` returns `true` for `display: none`, `visibility: hidden`, `opacity: 0`, and offscreen elements, and `offsetParent` is `null` for none of them. Only `getComputedStyle` reports the truth, and no `visible` flag is offered on that thin basis.
- A value the payload reports as `subtype: null` is reported as null with the ambiguity named, never as a specific one of undefined, null, or NaN.
- A result larger than the eval cap is truncated with a note, and the note says how much was dropped: the model is never silently handed a partial value.
- The engine's private and loopback refusal lives in its network layer, so eval does not widen what the browser can reach: probe verified, page script `fetch` to a local server failed with `AbortError: net::ERR_FAILED` and never reached the server, and `location.href = <loopback>` was rejected outright, exactly as `Page.navigate` to loopback already is.
- No call hangs: bounded by the caller's abort signal and 30 seconds (carried), with the engine death verdict raised on a timeout instead of leaving a wedged engine behind.
- A condition mode expression is the caller's own JavaScript, so it carries eval's hazard and nothing worse: it is the same interpreter path, the same clock, and the same recovery.
- An awaited promise is self bounded at 30 seconds by both evaluator paths, each with its own message ("Runtime.evaluate" and "Runtime.callFunctionOn" promise did not settle within 30000ms), and the session answers again straight after, so an awaited call raises no death verdict (probe verified).
- The engine down verdict on a timeout has to survive the error mapper: the timeout error is raised already classified and already marked engine down, because the mapper would otherwise rewrite the message and `runExclusive` would lose the marker that raises the verdict.
- A cyclic object and `window` are not detectable degradations: the engine serialises both to the ordinary string `[object Object]`, so the tool reports that string as a plain value (probe verified).

**Security model**: unchanged from spec 0004 and spec 0006: single actor (the pi agent inside the pi process under the user's account), no roles, no tenants, no regulated data, no credentials, and the same trust domain as shell tools. Two things are worth stating because this feature is the one that runs arbitrary page JavaScript. First, an eval reads whatever the page can read and the result lands in the transcript, which browser_read already does for page text, so nothing new is exposed to the caller. Second, the engine's private and loopback refusal is in its network layer, so eval cannot be used to reach services on the local machine (probe verified), which keeps the guard every earlier slice relies on intact. The wait's status line text is the mode and the literal the caller passed, so nothing page derived is written to the status line.

**Configuration required**: none new. Five code constants join the existing ones: the eval result cap, the wait default clock (10 seconds), the wait range (500 ms floor, 25 seconds ceiling), the poll interval (100 ms), and the reserve the final snapshot, the page info read, and the queue release share (5 seconds). The spec 0004 follow up that would turn the timeout and cap constants into plugin configuration stays open, and these five join its list rather than opening their own config surface.

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: eval a statement script for a value, eval an element by ref with `return this.textContent`, wait on text that appears after a delay, wait on a selector, wait on a condition, then read the page and act on a ref; succeeds end to end. Verifies **AC-1**, **AC-2**, **AC-6**, **AC-13**.
- Degraded values: eval an expression returning a DOM element, a Promise, a Map, and null; each is reported in plain words, nothing dumps computed styles, and the Promise case names `await: true`. Verifies **AC-1**, **AC-3**.
- Await bound: eval with `await: true` on a promise that never settles; the caller gets a plain message naming the engine's own 30 second bound, and a later call still works. Verifies **AC-3**, **AC-4**.
- Wait verdicts: a wait for text that never appears returns `appeared: false` with fresh refs and where the page is, and a wait for a mistyped selector does the same while naming the selector. Verifies **AC-6**, **AC-8**, **AC-9**.
- Refusals: zero modes and two modes are refused in plain words; an out of range `timeoutMs` is clamped with a note; a condition that throws refuses at the first tick; a stale ref on eval is refused. Verifies **AC-5**, **AC-7**, **AC-11**.
- Concurrency: a five second wait started beside a `browser_read`; the read completes only after the wait ends, and it reports the post wait page state. Verifies **AC-10**, **AC-13**.
- Wedge recovery: eval an uninterruptible loop (`while (true) {}`), let the tool clock expire, then confirm the next browser call starts a fresh engine and works. Costs one full 30 second clock, so it runs last. Verifies **AC-12**.

## Build plan

Built against the real engine, per the project's Tracer Bullet approach: one thin end to end thread first (a real expression through the real engine to a real tool result), then thicken each strand. Every task names the AC it satisfies.

1. [x] Eval core, end to end: register `browser_eval` through the queue, run the expression as a script through `Runtime.evaluate` with `returnByValue`, read the completion value, report it with its type label and the code constant cap, and add the two degradation guards (an object carrying `_nid` is an element, reported as such; an empty object is reported as the empty object it is, with the Promise, Map, and Set hint) plus the null ambiguity note. Read a page script error from the response's exception details and report the message with the first stack line, then the URL and title. Satisfies **AC-1**, **AC-4**.
2. [x] Await and the ref form: the `await` flag through `awaitPromise` on both paths, its timeout message naming the engine's own 30 second promise bound, and the message pointing at `await: true` when a promise reads as `{}`; then the `ref` path through a fresh snapshot, `DOM.resolveNode`, and a `Runtime.callFunctionOn` that takes `awaitPromise` from the flag rather than the shared action helper's hardcoded true, reading a page error from the `JS error:` protocol shape, with the stale ref refusal. Satisfies **AC-2**, **AC-3**.
3. [x] Wait, text mode, end to end: register `browser_wait`, the poll loop inside one `runExclusive` with the plugin owned expression for `text`, the code constant poll interval, the poll deadline of the smaller of the own clock and the tool clock minus the reserve, the honest `appeared: false` result, the refs and URL and title snapshot on both exit paths, the status line written for the duration and restored when the wait ends, and the abort signal checked every tick and raced against the sleep. Satisfies **AC-5**, **AC-6**, **AC-7**, **AC-8**, **AC-9**, **AC-10**.
4. [x] Selector and condition modes: the plugin owned `selector` expression and the caller's `condition` expression, the invalid selector fact in the timeout message, failing fast when a condition throws, and the zero or two mode refusal. Satisfies **AC-5**, **AC-6**, **AC-11**.
5. [x] Hang recovery and the self check: raise an eval or wait timeout as one error already classified and already marked engine down when page evaluation was still outstanding and no promise was being awaited, with a message naming a possibly running script; then extend `scripts/` with a script and wait self check covering every AC-13 case including the concurrent read behind a wait, and record the loop wedge probe in `rationale.md`. Satisfies **AC-11**, **AC-12**, **AC-13**.

## Consequences

**Positive**:
- The plugin's surface is complete for a real browsing flow: navigate, read, act, reach in, and synchronize, all through pi tools.
- The engine's real limits are recorded rather than rediscovered: the 30 second await bound, the absent visibility model, the invalid selector that returns null, the loop that wedges, and the network layer loopback refusal are all in the rationale probe record and in the invariants.
- A wedged engine is recoverable without a `/reload`: the timeout raises the death verdict and the next call spawns a fresh engine, which is a smaller failure than the current one where every later call fails.
- The wait hands back fresh refs on both exit paths, so "wait then act" is one call, not two.
- An unanswered wait is honest data (`appeared: false` plus where the page is), so the agent can choose to wait again, read, or give up, instead of treating a timed out call as a broken tool.

**Negative / tradeoffs**:
- A wait holds the one queue for up to 25 seconds, so any other browser call started meanwhile waits for it; that is the price of the never interleave invariant every earlier slice depends on.
- `browser_eval` can run an uninterruptible loop, and no plugin side clock can stop page JavaScript: the caller is freed at 30 seconds, and the engine is recovered by a restart, which costs the session its page state.
- An awaited promise can stall the whole engine for its full 30 second bound, and during that window nothing else evaluates (probe verified); `await: true` is therefore opt in.
- An eval or wait timeout restarts the engine even when the page was merely slow, because the plugin cannot tell a slow page from a wedged one at the clock, so a slow page loses its session state. An awaited call is exempt, since that bound is provably self healing.
- The eval result cap means a large value arrives trimmed, with the note as the only warning.
- A text match is text in the document, not text a person can see, because this engine cannot tell the difference; a wait for text that only exists inside a hidden panel matches immediately.
- A mistyped selector costs the full wait before it reports no match, since this engine returns null rather than throwing.
- Both tools take caller authored JavaScript, so a mistake in an expression reads as a page error, not a tool error, and the message is the page's own.

**Neutral**:
- Two tools, four new code constants, and one new engine death trigger; the ref contract, the queue, the error mapper categories, and the configuration surface are all unchanged.
- `browser_eval` does not carry refs (the next action's freshness check handles whatever the eval changed), while `browser_wait` does; the asymmetry is deliberate and matches what each tool is for.
- The wait's condition mode reuses eval's interpreter path exactly, so it introduces no new class of hazard.
- A newer engine that ships a working visibility test, an interruptible evaluation, or a non blocking await would let the `visible` flag, the loop recovery, and the await cost all improve without a surface change.

## Follow-up

- [ ] `/check verify script & wait` next; its checklist includes the wedge recovery case, which costs one full 30 second tool clock and should run last.
- [ ] The engine's loopback refusal arrives as a CDP protocol error, not as `Page.navigate`'s `errorText`, so spec 0004's tailored "Check the URL and try again" message never fires for it and the generic "the navigation failed: Network error: Access to private/internal IP address 127.0.0.1 is not allowed" is what shows (found while probing this feature). A one line fix in `browser.ts` when someone is next in it.
- [ ] The spec 0004 follow up is still open: the timeout and truncation constants become feature 3 configuration. This spec adds the eval result cap, the wait default and range, the poll interval, and the reserve to that list.
- [ ] Found while probing this feature, and it belongs to spec 0006's surface rather than this one: the action core's `callFnOn` reads `exceptionDetails`, but this engine never sends that for `Runtime.callFunctionOn`, so a page error there arrives as the CDP protocol error `JS error: <page message>` and spec 0006's tailored "the page script failed: …" message never shows. One small addition to the error mapper closes it for every action tool, and the eval ref path already reads the same shape.
- [ ] No `visible` requirement is offered, because nothing on this engine can test visibility honestly. Re visit if a newer engine ships a working `checkVisibility` or a layout aware `innerText`.
- [ ] A newer engine that makes `querySelector` throw on a malformed selector would let the wait refuse a mistyped selector up front instead of waiting for the clock.
- [ ] The engine answers no other evaluation while it awaits a promise. Re visit if that changes, since a non blocking await would make `await: true` cheap enough to be the default.
- [ ] An uninterruptible page script has no in page escape; the plugin recovers by restarting the engine. If a newer engine ships a per evaluation time limit or an interrupt, the restart can go away.
- [ ] No navigation wait mode: `browser_navigate` already waits for the page to load. Re visit only if a workflow needs "wait for the URL to change".

## Rationale

Reasoning, the options weighed, and the probe record: see [rationale.md](rationale.md).
