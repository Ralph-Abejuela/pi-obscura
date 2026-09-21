# Verify: script & wait · spec 0007 · updated 2026-09-21
_Steps derived from spec 0007 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

Every step below runs in a real pi session with this extension wired in, against a page you opened yourself (a real site, or a `data:` URL fixture). The engine refuses loopback and private addresses, so a local server cannot serve the fixture. Run the wedge recovery step last: it costs one full 30 second tool clock and it restarts the engine, which throws the page state away.

## UI / manual
- [ ] `browser_eval` with `1 + 1` → the result reads `The script returned number: 2`, then where the page is → AC-1
- [ ] `browser_eval` with `const a = 1; a + 1` → `2` (a statement list keeps its completion value) → AC-1
- [ ] `browser_eval` with `if (true) { 5 }` → `5` → AC-1
- [ ] `browser_eval` with `document.body` → `(a DOM element)` plus the note saying to return a property instead; no computed style dump in the transcript → AC-1
- [ ] `browser_eval` with `new Map([['a', 1]])` → `{}` plus the note naming Promise, Map, and Set → AC-1
- [ ] `browser_eval` with `null` → `null` plus the note naming undefined, null, and NaN → AC-1
- [ ] `browser_eval` with `window` → `"[object Object]"`, reported as the plain string the engine actually sent → AC-1
- [ ] `browser_eval` with `'x'.repeat(25000)` → `truncated: true`, the value cut at 20000 characters, the note naming the real length → AC-1
- [ ] `browser_eval` with `return this.textContent` and a ref from `browser_read` → the element's own text, and the result names the ref → AC-2
- [ ] `browser_eval` with `this.textContent` (no `return`) and a ref → `null` plus the ambiguity note, proving the ref form is a function body → AC-2
- [ ] `browser_eval` with the ref of an element and `return this.textContent` after a navigation → refused, naming the stale ref and telling you to call `browser_read` → AC-2
- [ ] `browser_eval` with `new Promise(function(r){setTimeout(function(){r(42)}, 200)})` and no await flag → `{}` plus the note naming `await: true` as the fix → AC-3
- [ ] The same expression with `await: true` → `42`, and the same on the ref form with `return new Promise(...)` → the settled value → AC-3
- [ ] `browser_eval` with `new Promise(function(){})` and `await: true` → a plain message naming the engine's own 30 second bound, no engine restart, and the next call works → AC-3
- [ ] `browser_eval` with `throw new Error('boom')` → the page's own message with its first stack frame, and the next call works → AC-4
- [ ] `browser_eval` with `const = ;` → the page's SyntaxError message → AC-4
- [ ] `browser_eval` with `return this.nope.deep` and a ref → the page's TypeError, read from the `JS error:` protocol shape → AC-4
- [ ] `browser_wait` with no mode → refused, naming text, selector, and condition → AC-5
- [ ] `browser_wait` with both `text` and `selector` → refused, naming both and the three modes → AC-5
- [ ] `browser_wait` with `text` for text that appears a moment after you call → `appeared: true`, the mode, the literal, the elapsed time, the URL and title, and fresh refs → AC-6, AC-8, AC-9
- [ ] `browser_wait` with `text` for text that never appears → `appeared: false` with the same fields plus a next step, as a normal result, not an error → AC-8, AC-9
- [ ] `browser_wait` with `selector` for an element that appears late → `appeared: true` → AC-6
- [ ] `browser_wait` with `selector` `[[` → `appeared: false` after the full clock, with the note naming the mistyped selector and this engine's null behaviour → AC-6
- [ ] `browser_wait` with `condition` `window.__flag === true` on a page that sets the flag late → `appeared: true` → AC-6
- [ ] `browser_wait` with a `condition` that throws (`document.getElementById('nope').value`) → refused at the first tick, well before `timeoutMs` → AC-11
- [ ] `browser_wait` with `timeoutMs: 10` → the wait still runs, with the note naming the clamp to 500 ms → AC-7
- [ ] `browser_wait` with `timeoutMs: 25000` for text that never appears → `appeared: false` after about 25 seconds, not the 30 second tool timeout → AC-7, AC-8
- [ ] While a `browser_wait` polls, watch the pi status line → it names the mode and the literal for the wait's whole duration, then returns to the engine's own state text → AC-10
- [ ] Start a `browser_wait` for text that appears after a moment, then issue `browser_read` → the read completes only after the wait ends, and reports the page as the wait left it → AC-10
- [ ] Abort a running `browser_wait` (Escape the tool call) → it stops at once instead of polling out its clock, and the next browser call works → AC-10
- [ ] Start a `browser_wait`, then let the page navigate itself (`location.href`) mid wait → the wait survives, keeps polling, and reports the page it ended on → AC-11
- [ ] `browser_wait` with `text` that only exists inside a `display: none` element → `appeared: true`, the honest reading of this engine's text model → AC-6
- [ ] Last: `browser_eval` with `while (true) {}` → the tool clock expires with the message saying a page script may still be running and the engine is treated as down, then any browser call starts a fresh engine and works → AC-12
- [ ] `browser_probe` after the wedge → the engine is up again, on a new session with no page state → AC-12

## Commands
- [ ] `npm run typecheck` → clean → build gate
- [ ] `npm run lint` → clean → build gate
- [ ] `node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs scripts/script-selfcheck.ts` → `script and wait self-check passed` → AC-1 to AC-11, AC-13
- [ ] `node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs scripts/interaction-selfcheck.ts` → passes, proving the exported `findFreshRef` and `objectForNode` changed nothing for the action tools → no regression
- [ ] `node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs scripts/navigation-selfcheck.ts` → passes → no regression

## Value sourcing coverage
Each row of the spec's value sourcing table, and the edge that would break if the source were wrong.
- [ ] The eval value comes from the `Runtime.evaluate` result's `value` field, not from the script's own text: eval `1 + 1` and confirm `2` → not `"1 + 1"` → AC-1
- [ ] The type label comes from the payload's type, subtype, and class name: eval a number, a string, an array, and an object literal and confirm the label is `number`, `string`, `array`, and `object` → AC-1
- [ ] The degraded value note is derived from the serialised value, not a guess: eval `document.body`, a `Map`, a `Set`, and a `Promise` and confirm the element note for the first and the shared empty object note for the rest (never a claim about which one it was) → AC-1
- [ ] The null ambiguity note comes from the payload being null shaped: eval `undefined`, `null`, and `NaN` and confirm the same reading three times → AC-1
- [ ] The awaited value comes from the `await` flag plus the engine's own bound: eval a two second promise with and without `await: true` → the value with it, `{}` without it → AC-3
- [ ] The element for a ref comes from the fresh snapshot's backend node id through `DOM.resolveNode`: `browser_read`, then eval `return this.textContent` with that ref → the element's own text → AC-2
- [ ] The URL and title come from the `pageInfo` read after the evaluation: eval `1 + 1` on two different pages and confirm the reported URL and title change with the page → AC-1
- [ ] The ref path's page error comes from the CDP protocol text, not exception details: eval `return this.nope.deep` with a ref → the page's TypeError → AC-4
- [ ] The ref path's awaited value comes from `awaitPromise` on `callFunctionOn`: `return new Promise(...)` with `await: true` and a ref → the settled value → AC-3
- [ ] The wait's verdict comes from one poll expression per tick: a `text`, a `selector`, and a `condition` wait that each match and then each time out → both verdicts per mode → AC-6
- [ ] The text poll expression is `innerText`, so text anywhere in the document counts: wait for text inside a `display: none` element → matches → AC-6
- [ ] The selector poll expression is `querySelector(...) !== null`, so a malformed selector reads as no match: `selector` `[[` → `appeared: false` with the note, no crash → AC-6
- [ ] The condition poll expression is the caller's own expression: `condition` that returns `0` → no match; that returns `1` → match → AC-6
- [ ] The elapsed time is the wall clock: a wait with `timeoutMs: 2000` for text that never appears → an elapsed time close to 2000 ms, not the poll interval → AC-8
- [ ] The wait's own bound comes from `timeoutMs`, clamped: `timeoutMs: 400` → the clamp note; `timeoutMs: 30000` → the clamp note at 25000 → AC-7
- [ ] The poll interval is the 100 ms code constant: a wait whose text appears about a second in on a ticking page → it matches within about 100 ms of the text arriving → AC-7
- [ ] The fresh refs come from the same snapshot `browser_read` makes: use a ref from the wait result straight away with `browser_click` → the click lands, no stale ref refusal → AC-9
- [ ] The clamp note comes from comparing the input against the range: a mid range `timeoutMs` shows no note, one out of range shows it → AC-7
- [ ] The timeout verdict comes from the 30 second tool clock and the reserve: a 25 second wait for text that never appears returns `appeared: false` rather than the generic tool timeout → AC-7
- [ ] The engine down verdict on a timeout comes from whether an evaluation was still outstanding: the `while (true) {}` eval raises the engine down message, a slow page that answers does not → AC-12
- [ ] The poll deadline comes from the smaller of the wait's clock and the tool clock minus the reserve: the 25 second wait still reports its own verdict with fresh refs, and the queue is free straight after → AC-7, AC-10
- [ ] The tick verdict comes from the poll response: a page navigating under the wait is retried, and a condition that throws fails fast → AC-11
- [ ] The status line text comes from the wait's own write and the supervisor's state text: watch it during a wait and after it ends → AC-10

## Acceptance-criteria coverage
- AC-1 covered by the plain expression, statement script, degraded value, null, window, and cap steps
- AC-2 covered by the ref form, the no `return` step, and the stale ref refusal
- AC-3 covered by the await on and off steps, the promise bound step, and the awaited value sourcing steps
- AC-4 covered by the thrown error, syntax error, ref path TypeError, and next call works steps
- AC-5 covered by the zero mode and two mode refusals
- AC-6 covered by the text, selector, condition, hidden text, and malformed selector steps
- AC-7 covered by the clamp step, the 25 second step, the poll interval sourcing step, and the deadline sourcing step
- AC-8 covered by the matched and not matched verdict steps, and the elapsed time sourcing step
- AC-9 covered by the refs on both exit paths and the refs sourcing step
- AC-10 covered by the status line steps, the read behind a wait step, and the abort step
- AC-11 covered by the throwing condition, the navigating page, and the three failed tick retry policy
- AC-12 covered by the wedge recovery step, the `browser_probe` step, and the engine down sourcing step
- AC-13 covered by the `scripts/script-selfcheck.ts` command, which runs every case in the acceptance criterion
