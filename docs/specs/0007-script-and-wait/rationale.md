# 0007 rationale. Script and wait tools

Decision record for [index.md](index.md). This file holds the reasoning, the options weighed, the calls made on the engineer's behalf, and the probe record; `/develop` does not need it.

## Context

Slice 1 gave the agent a way to open a page and read it. Slice 2 gave it a way to act on the page. Both stay inside what the plugin's own serializers and ref contract can express. Two gaps remain, and they are the two ways a real browsing task outgrows a fixed tool surface.

The first gap is the fixed surface itself. A page's useful data is often not in its markdown: a JSON blob in a script tag, a value the page computed, a framework's own state object, a computed style, a form's validity, an API the page exposes on `window`. The read tool answers "what is on this page as prose"; only the agent knows what else it needs. The engine already exposes `Runtime.evaluate`, so the plugin can hand that reach to the agent rather than guessing at every future read shape.

The second gap is time. A page that renders after load, a search result list that fills in later, a modal that appears when a request finishes, a widget that only becomes interactive a moment later: reading at the wrong moment produces a confident, wrong answer, and the agent's only current remedy is to call `browser_read` repeatedly and hope. A wait is the tool that turns "is it there yet" into one call with a definite answer.

The forces at play come from the plugin's own established shape, not from this feature. All CDP work runs through one supervisor queue and never interleaves (spec 0001, rechecked in spec 0004 and spec 0006). Every operation is bounded by the caller's abort signal and a 30 second clock, and every failure arrives as plain text with a next step, mapped into four categories (engine down, page error, protocol unsupported, timeout). Element references are addressed through a fresh snapshot, never an older read (spec 0006). Engine behaviour is probe verified before it is designed around, and each verified limit is recorded so the next slice does not rediscover it.

The engine itself shapes the design more than the tools do. It has no wait of its own, so any wait is either a plugin side poll or one long page side promise. It bounds an awaited promise at exactly 30 seconds, and answers nothing else while it waits. It has no visibility model whatsoever, so "wait until the element is visible" cannot be offered honestly. A synchronous loop in page JavaScript cannot be interrupted from outside the page. Every one of those facts is in the probe record below, and each one eliminated an option that would have looked reasonable on paper.

## Options considered

### Option 1: A typed evaluator plus a one mode polling wait that holds the queue (chosen)

`browser_eval` returns the script's completion value, typed, capped, with explicit guards for the values this engine degrades (an element, a Promise, a Map). It awaits only when asked, and takes an optional ref for the element as `this` case. `browser_wait` takes exactly one of `text`, `selector`, or `condition`, polls every 100 ms inside the one queue with its own 10 second default clock, and reports `appeared` plus fresh refs whether or not it matched.

**Pros**:
- Only the two tools that genuinely need arbitrary page JavaScript run it, so the hazard (an uninterruptible loop) stays on two recoverable paths instead of the whole surface.
- The result shape hides the engine's degradation quirks instead of passing them to the model, so a Promise never silently returns `{}` and an element never dumps 300 KB of computed styles.
- The wait holds the one queue, keeping the never interleave invariant every earlier slice relies on.
- An unanswered wait is honest data rather than a tool failure, so the agent chooses the next step.
- Fresh refs on both wait paths make "wait then act" one call.

**Cons**:
- Two parameter combinations (ref plus script versus body, await on versus off) need clear wording in the tool description, or the agent writes the wrong shape.
- A wait holds the queue for up to 25 seconds, so a concurrent browser call waits for it.
- Four more code constants join a list that spec 0004 already flagged as wanting configuration.

### Option 2: Return the CDP payload verbatim and offer a raw wait

`browser_eval` hands back the protocol's own `{type, subtype, className, description, value}` and the wait takes a raw JavaScript condition only. Maximum fidelity, minimum interpretation, and a much smaller design conversation.

**Pros**:
- Almost no interpretation layer to get wrong: what the engine said is what the caller sees.
- A single wait mode means no mode refusal and no per mode documentation.

**Cons**:
- The probe shows the raw payload actively misleads: an element arrives as `{}` with `_nid` and a full computed style dump, and a Promise arrives as `{}` with no hint about `await`. Pushing that onto the model wastes context and invites wrong conclusions.
- A condition only wait makes the common "wait for this text" a JavaScript authoring exercise for every call.
- The model reads protocol fields (`subtype`, `className`) that the rest of this plugin deliberately translates into plain words.

### Option 3: Text and selector waits only, no arbitrary JavaScript wait

`browser_eval` as in the chosen option, but `browser_wait` limited to `text` and `selector`, so no wait can ever run caller authored JavaScript and no wait can wedge the engine.

**Pros**:
- A wait can never hang the engine, because the plugin owns every expression it evaluates.
- A smaller wait surface: two modes, no condition refusal, a simpler tool description.

**Cons**:
- The scope row asks for "text or a condition", and the condition case is the one that covers everything the other two cannot say (a count, a computed state, a combination).
- The hazard it avoids is already introduced by `browser_eval`: if the agent can wedge the engine, forbidding it in the wait buys nothing.
- An any-of or compound wait becomes a two call dance (wait for one, then eval) instead of one expression.

### Option 4: A yielding wait, and eval that always awaits

The same surfaces, but the wait releases the queue between polls so concurrent reads interleave, and eval always awaits a promise so `fetch` and async page helpers just work.

**Pros**:
- The agent can read a page while a wait continues, which is closer to how a person browses.
- No `await` flag to explain: an async expression behaves the way a caller expects.

**Cons**:
- Releasing the queue breaks the invariant every earlier slice is built on: a read could report a page state the waiting call is actively changing, and generated refs would move under it.
- Always awaiting means any hanging promise stalls the whole engine for 30 seconds with no way for the caller to know it was coming (probe verified: nothing else evaluates during that window).

## Rationale

The chosen option follows from three of the probe facts and from one project rule.

The evaluator's shape comes from how badly this engine degrades unusual values. A DOM element with `returnByValue` on is not an error, it is an object carrying `_nid` and a full computed style map, and a Promise is `{}` with no distinguishing field. A tool that forwards that payload makes the model interpret a serialisation bug as data. So the value is typed, capped, and guarded: an object with `_nid` is reported as an element with the suggestion to return a plain value, an empty object is reported with the Promise and Map explanation plus the `await: true` fix, and a value the payload reports as null carries the note that undefined, null, and NaN are indistinguishable here. Those three notes are the whole value of the interpretation layer, and each one is grounded in a verified fact rather than a guess.

The `await` flag is off by default because the cost of awaiting is not local. The probe shows the engine itself rejects an unsettled promise at exactly 30 seconds, which makes awaiting survivable rather than dangerous, but it also shows that during that window the engine answers no other evaluation at all. An evaluation that silently costs 30 seconds of engine wide stall, on a path the agent may be using to poke at a page, is a bad default. Making it opt in keeps the common synchronous evaluation fast and makes the async case a deliberate request, with the engine's own message as the failure mode.

The wait holds the queue because that invariant is what makes every element reference in the plugin trustworthy. Refs are re derived from a live snapshot and every action verifies them against a fresh one; a wait that let a read or an action interleave would keep the ref contract technically intact while making the page state the waiting call was watching move underneath it. The cost is bounded and visible: a 10 second default clock, a 25 second ceiling kept below the 30 second tool clock, a status line that names what the wait is watching, and a result that says how long it held. A concurrent call waits, then runs, which is the behaviour the rest of the plugin already guarantees.

The timeout on an eval or wait marks the engine down rather than reporting and moving on. This is the one place where the design accepts a real cost (a slow page loses its session state to a restart) to avoid a much worse one (a wedged engine that fails every later call until a `/reload`). The probe put a hard edge on it: a page script in an infinite synchronous loop blocks the engine permanently, with no rejection and no exit, and nothing outside the page can interrupt it. The plugin cannot tell an interruptible loop from a slow page at the 30 second boundary, so it takes the recoverable failure. The engine process it kills is one the plugin spawned and owns (spec 0003's rule about never killing an unowned process is untouched).

That rule is narrower than it first looks, and the cross check is the reason. It fires only while page evaluation is still outstanding, because a timeout after the wait's poll loop has finished says nothing about the page. And an awaited call is exempt entirely: both evaluator paths bound an awaited promise at exactly 30 seconds and the session comes back immediately after, so killing the engine there would pay a restart for a wound that had already healed. The remaining cost is real and stated in the consequences: a genuinely slow page loses its session state to a restart, because the plugin cannot tell slow from wedged at the clock.

The engineer overrode one recommendation: `browser_eval` takes an optional ref, running the expression with the element as `this`. That is kept, and it brings one real wrinkle with it, which is recorded as a rule rather than hidden: through `DOM.resolveNode` and `Runtime.callFunctionOn` the expression becomes a function body, so a value needs `return`, while the no ref path keeps the engine's own script semantics where the last expression's value comes back. The two shapes are documented in the tool description and its guidelines. The alternative (one uniform function body) would give up the completion value the engine already provides for free on the common path, and the other alternative (wrapping the expression in a direct `eval` so both paths behave identically) buys uniformity with a subtler mechanism, which is the wrong trade for a tool whose whole job is to be predictable.

The engineer also chose to keep the 30 second tool clock as is rather than giving the await path its own longer bound. The cost is that the engine's own precise message ("did not settle within 30000ms") races the plugin's generic timeout and may lose; the mitigation is in the spec, not in the clock: the timeout message for an awaited call names the promise case explicitly, so the caller is never left guessing whether the page hung or the promise did.

## Calls made on the engineer's behalf

These are implementation grade decisions settled here with full context, rather than asked one at a time. Each names the runner up, so a later reviewer can see the road not taken.

- **The wait's final snapshot shares a 5 second reserve with the tool clock.** The runner up was lowering the wait's ceiling to 20 seconds with a 10 second reserve; rejected because the engineer chose a 25 second ceiling, and 5 seconds covers the snapshot, the page info read, and the queue release on any page this plugin has seen. If a real page's snapshot needs longer, the ceiling should drop rather than the reserve.
- **The wait polls from the plugin, not from one page side promise.** One `Runtime.evaluate` per tick, 100 ms apart. The runner up was a single page side promise with `awaitPromise`, which is one CDP round trip instead of many: rejected because it hands the clock to the engine, cannot be cancelled between ticks, and its 30 second engine bound would fight the tool clock on every long wait. Plugin side polling also lets the abort signal release the queue between ticks.
- **The eval result cap is 10,000 characters.** The runner up was 60,000 to match the read tool's markdown cap; rejected because a JavaScript value is usually meant to be consumed, not read, and 10,000 characters is already a great deal of JSON for one tool result. The truncation note names the cap and what was dropped.
- **A condition that throws fails at the first tick.** The runner up was to swallow the throw and keep polling until the clock expires; rejected because a broken condition (a typo, a missing global) will never become true, so failing fast reports the real problem at once instead of after the wait.
- **A navigation during a wait keeps polling**, and the result reports the URL the page finally reached. The runner up was to refuse when the URL changes; rejected because a wait for text on a page that redirected mid wait is a legitimate flow, and the reported URL tells the caller what happened.
- **Text matching is case sensitive.** The runner up was case insensitive matching; rejected because a caller who wants case insensitivity can express it exactly in `condition`, while a silent case fold hides a mismatch the caller did not intend.
- **The poll literals are JSON encoded into the poll expression**, never string concatenated raw, so a value containing a quote, a backslash, or a newline cannot break the expression or turn a wait into an injection. This is why the `text` and `selector` modes are plugin owned expressions with data passed in, not caller authored code.
- **The status line says what the wait is watching** (mode and literal) while it holds the queue, and the supervisor's existing status line is reused. The runner up was no status chatter during a wait; rejected because a wait that holds every other browser call for up to 25 seconds must be visible in the UI while it does it.

## Cross check

An independent read only pass over the drafted spec, on a different model from the one that wrote it, looked for decision completeness (values an acceptance criterion needs whose source the spec does not name, and decisions a builder would otherwise have to invent) and for soundness. It found nine things worth closing, all of which the engineer asked to be applied:

1. **The timeout to engine down mechanism was unnamed.** Now explicit: an eval or wait timeout is raised as one error already marked classified and already marked engine down, because the error mapper would otherwise rewrite the message and `runExclusive` would lose the marker that raises the verdict.
2. **The death verdict was too broad.** An awaited call would have killed a healthy engine, since the plugin's clock starts before the engine's own bound and wins the race. The verdict now fires only while page evaluation is still outstanding, and never for an awaited call (probe 8 shows that bound is self healing).
3. **The wait's ceiling left the final work outside the tool clock.** The poll deadline is now the smaller of the wait's own clock and the tool clock minus a named 5 second reserve that the final snapshot, the page info read, and the queue release share.
4. **AC-1 claimed a cyclic object could be detected**, which the probe record contradicts: it arrives as an ordinary string. Dropped from the guard and recorded as an invariant instead.
5. **The empty object guard overclaimed**: a legitimate `{}` would have been reported as a Promise, a Map, or a Set. It now reports the value truthfully and adds the hint.
6. **The ref path contradicted the await flag**, because the shared action helper hardcodes `awaitPromise: true`. The ref path now sends the flag through itself, and its page error shape (`JS error: …`, a protocol error rather than exception details) is part of AC-4.
7. **The status line had no write path and no restore.** The wait tool writes and restores it through the surfaces the plugin already has, with no new supervisor API.
8. **A mid wait navigation would have read as a broken condition.** A page script error now fails fast while a transport or context error is retried, up to three consecutive failed ticks.
9. **An aborted wait could orphan its poll loop** and keep evaluating outside the queue. The loop now checks the abort signal every tick and races its sleep against it, the pattern the action tools' quiet delay already uses.

## Probe record

Eight throwaway scripts, run against the local engine (`~/.pi/agent/bin/obscura.exe`, version 0.2.2) on 2026-09-21. Probes 1 to 6 ran during the design conversation; probes 7 and 8 were added while answering an independent cross check of the drafted spec. They live in the gitignored `scratch/` and are the evidence for every engine claim in [index.md](index.md). Each ran a headless engine on a free loopback port with a `data:` URL fixture, since the engine refuses loopback navigation.

```bash
# 1. Runtime.evaluate return shapes, exceptions, promises, first wedge sighting
node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs scratch/probe-eval-wait.ts
# 2. DOM APIs a wait can use, and the exact length of the await wedge
node .../jiti-cli.mjs scratch/probe-eval-wait2.ts
# 3. Text semantics, checkVisibility, MutationObserver, an uninterruptible loop
node .../jiti-cli.mjs scratch/probe-eval-wait3.ts
# 4. Script versus expression semantics, and every visibility signal
node .../jiti-cli.mjs scratch/probe-eval-wait4.ts
# 5. Can a Promise or an element be told apart from a plain object
node .../jiti-cli.mjs scratch/probe-eval-wait5.ts
# 6. Does page script reach loopback even though navigation refuses it
node .../jiti-cli.mjs scratch/probe-eval-wait6.ts
# 7. callFunctionOn error shapes, and its await bound (first reading, with a bug in that probe's error handling)
node .../jiti-cli.mjs scratch/probe-eval-wait7.ts
# 8. the callFunctionOn await bound, measured precisely, which corrected probe 7
node .../jiti-cli.mjs scratch/probe-eval-wait8.ts
```

**The evaluated expression is a script with a completion value.** `1 + 1` gives 2, `const a = 1; a + 1` gives 2, `var b = 2; b * 3` gives 6, `if (true) { 5 }` gives 5, and a script with a trailing comment still returns its value. A top level `return` is a `SyntaxError: Illegal return statement`. A declaration alone (`let c = 1`) reports the null shape.

**The result payload and its degradations.** `returnByValue` on gives `{type, subtype, className, description, value}`. A number, string, object, and array serialise cleanly. `undefined`, `null`, and `NaN` are indistinguishable: all three arrive as `subtype: null, description: "null", value: null`. A DOM element arrives as `type: object, className: Object` with a `value` carrying `_nid` and a `_style` map of hundreds of computed style properties. A Promise, an async IIFE result, and a Map all arrive as an empty object. A cyclic object and a `window` arrive as the string `"[object Object]"`, a function as its source text, a bigint as a string, and a symbol as an empty string. With `returnByValue` off, the honest label is available instead: `subtype: node, className: HTMLDivElement` for an element, `className: Promise` for a promise, `className: Map`, `className: Window`, `className: HTMLDocument`.

**Exceptions.** A throw arrives as `exceptionDetails` with `exception.description` carrying the page's own message and stack (`Error: boom` followed by eval frames), for a thrown `Error`, a thrown string, a `ReferenceError`, a `SyntaxError`, and a rejected promise alike. The same shape comes back whether or not `returnByValue` is on.

**Promises and the await bound.** `awaitPromise: true` awaits a settling promise correctly (a four second promise returned its value at 4005 ms). A promise that never settles is rejected by the engine itself after exactly 30 seconds with `Runtime.evaluate promise did not settle within 30000ms`, and **during that window the engine answers no other evaluation**: 30 one second polls all expired, and the first answer arrived at 30007 ms. The session recovers by itself afterwards. Without `awaitPromise`, a promise result is `{}`.

**The ref path bounds its await the same way, and reports its errors differently.** `Runtime.callFunctionOn` with `awaitPromise` awaits a settling promise correctly (a five second promise returned its value at 5013 ms) and rejects a promise that never settles at exactly 30001 ms with `Runtime.callFunctionOn promise did not settle within 30000ms`, after which the session answers at once. Probe 7's first reading of that case looked like an immediate resolution; that was a bug in the probe's own error handling (it converted the rejection into a resolved value), and probe 8 re measured it. A function body that throws does **not** come back as exception details on this path: it raises a CDP protocol error carrying the page's own text, `JS error: Error: body boom` with a stack, and a syntax error as `JS error: Uncaught SyntaxError: Unexpected token '='`. A promise without `awaitPromise` serialises to `{}` here too.

**Polling works and is cheap.** 200 ms polls ran for 12 seconds (59 ticks) with the session healthy, and a 100 ms poll saw a delayed DOM change. A three second synchronous page loop blocked its own evaluation for three seconds and the session survived it.

**An uninterruptible loop wedges the engine.** `while (true) {}` never returned and was never rejected; 45 seconds of polling got no answer, and the engine process stayed alive. Nothing outside the page can stop it.

**No visibility model exists.** `document.body.innerText` is byte for byte `textContent` on a fixture: it includes text inside `display: none` and `opacity: 0` elements, offscreen text, the text of `script` elements, and the text of `style` elements. `checkVisibility()` returns `true` for a `display: none` element, an `opacity: 0` element, a `visibility: hidden` element, and an offscreen element, with or without its option object. `offsetParent === null` is false for a `display: none` element. Only `getComputedStyle` tells the truth (`display: none`, `visibility: hidden`, `opacity: 0`), and `getBoundingClientRect` returns all zeros for a `display: none` element.

**DOM APIs present.** `document.querySelector`, `MutationObserver` (which does deliver callbacks), `getComputedStyle`, `checkVisibility`, and `getBoundingClientRect` all exist. An invalid selector is the surprise: `document.querySelector('[[')` returns `null` rather than throwing a `SyntaxError`, so a malformed selector is indistinguishable from a missing element.

**The loopback refusal lives in the network layer.** `Page.navigate` to `http://127.0.0.1:<port>/` fails with the CDP error `Network error: Access to private/internal IP address 127.0.0.1 is not allowed` and the page does not move. Page script `fetch` to the same server fails with `AbortError: net::ERR_FAILED` and the local server logs nothing, and `location.href = <loopback>` is rejected with the same private address error. So arbitrary page JavaScript cannot reach the local machine's services either, and the security model in spec 0004 and spec 0006 holds unchanged.

**One adjacent finding, recorded for whoever is next in the navigation code.** That loopback refusal arrives as a CDP protocol error, not as `Page.navigate`'s `errorText`, so `browser.ts`'s tailored "Check the URL and try again" message never fires for it and the caller reads the generic `the navigation failed: Network error: ...` instead. It is a one line fix and it belongs to spec 0004's surface, not this one, so it is carried as a follow-up rather than changed here.
