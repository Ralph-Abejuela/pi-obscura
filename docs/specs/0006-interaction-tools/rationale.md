# 0006. Interaction tools, rationale

## Context

Feature 6 (spec 0004) delivered the reading loop: navigate, read with numbered refs, back, forward, reload. The agent can see a page but cannot act on it. Feature 7 is the other half of browsing: click, fill, type, choose, scroll, and keys, addressed by the refs the read prints, so a multi step flow (search, fill, submit) completes inside the tool loop. The scope row records the done when: element references honest after each action.

The engine is a Rust headless browser speaking CDP, with its own coverage. Live probes (the record below) established the facts this decision rests on: a trusted click at a box center works (Input.dispatchMouseEvent), trusted typing works (DOM.focus plus Input.insertText, events fire with isTrusted true), trusted keys work for unmodified keys (Input.dispatchKeyEvent; it drops modifier state, see the probe record below), boxes come from DOM.getBoxModel by backend node id and are layout coordinates, elementFromPoint works for hit tests, and the JS paths for select value setting and scrolling work. Two methods Chrome has are missing here (DOM.pushNodesByBackendIdsToFrontend, DOM.getNodeForLocation), which rules out one whole addressing style and one hit test style.

The forces at play: faithfulness (pages must see real events), freshness (refs must never silently go stale), plain failures (the 0004 mapper style), and no new dependencies. The stack is fixed (spec 0001), the queue and mapper exist (spec 0004), the ref contract is fixed (spec 0004). This decision settles the dispatch mechanism, the addressing, the refs detail, and the result shape.

## Options considered

### Option 1: Trusted CDP input events primary, verified JS paths for the residuals

Real mouse, text, and key events through the Input domain, addressed by backend node ids through DOM.getBoxModel and DOM.focus. Select value and scroll use the JS paths (native setter plus change event; scrollIntoView and window.scrollTo), each probe verified.

**Pros**:
- Trusted events: pages and bot detection see isTrusted true (probe verified); framework inputs (React style) react to the input events.
- Uses the 0004 ref contract directly: refs carry backend node ids, and the engine accepts them in getBoxModel and focus without a resolution step.
- The event lands at a real point the layout computed, so overlay and hover behavior matches a human click.

**Cons**:
- Two mechanisms in one feature, each verified separately.
- Coordinate math: the center comes from layout coordinates and dispatch wants viewport coordinates, so the conversion subtracts the scroll offset; the self check pins it.
- A covered element refuses instead of clicking the cover; the agent must scroll or dismiss first.
- Modifier combos are out of reach: the engine accepts a modifier bitmask and still delivers an unmodified key, so browser_key offers the named map and single characters only (probe verified).

### Option 2: JS events only

Every action evaluates JavaScript in the page: element.click(), native value setter plus input event, dispatchEvent for keys, scrollIntoView.

**Pros**:
- One code path, no coordinate math, no box lookups.
- Works on any page the engine can evaluate on.

**Cons**:
- Untrusted events (probe verified isTrusted false on the input event): pages that verify the user gesture reject them, exactly the page class a browsing tool must serve.
- Skips layout behavior: no real hover, no real focus, no key repeat, and wheel and scroll shortcuts land differently.
- With no coordinates at all, an overlapping element receives the click and nothing can verify the intent (elementFromPoint still works, but it cannot drive a real event to a point of the agent's choosing).

### Option 3: Trusted primary with automatic JS fallback

Try the trusted dispatch, check that the page reacted, and on no reaction retry with the JS path, reporting which one worked.

**Pros**:
- Maximum coverage across odd pages.

**Cons**:
- A reaction check is guesswork: many pages react asynchronously or not at all to a successful event, so the fallback fires spuriously or misses real changes.
- More states to test at Alpha, where /check verify drives the live plugin and there is no test suite.
- The fallback hides engine gaps instead of surfacing them, which delays honest reporting.

## Rationale

The live probe decides it: trusted dispatch works on this engine for the paths that matter (click, typing, keys), so the feature uses it as the primary mechanism. The residuals are exactly the two paths the protocol cannot express (a native select has no event path; scrolling is a page affordance), and both are probe verified on the JS side, so nothing is unverified guesswork. Option 2 would ship untrusted events everywhere and fail on the pages a browsing tool must serve. Option 3 adds a spurious reaction check that Alpha verification cannot make reliable.

Addressing stays refs only: the engine cannot resolve backend ids to frontend nodes (pushNodesByBackendIdsToFrontend is missing, probe verified), and it does not need to, because the two methods that matter accept backend node ids directly. A selector escape hatch would add a second addressing system the read does not report and the freshness rule does not protect.

The refs contract extension (input type, select options) exists to make refusals plain: fill on a checkbox must name the kind, choose to a missing option must list the valid ones. Spec 0004's own follow up points here: the interaction tools resolve refs by backend node id as defined there, and reads between actions refresh them. The freshness rule goes further than 0004's wording, at the engineer's direction: every action, not just reads, refreshes refs, because the scope row says refs must be refreshed after each action and a light snapshot costs the same as a read snapshot.

Settle then report: a click that navigates should end with the engine telling the agent where it is, plus fresh refs, so the multi step flow never needs an extra read between steps. The settle wait reuses the verified readyState poll bounded by the existing 30 second clock.

The engineer's answers: all six tools in this pass (they share the dispatch core), fill replaces and type appends, a browser_key tool with a named friendly set, scroll takes a ref or an amount, plain refusals with reason and next step, and no References section.

The key surface was narrowed after the build task 3 probe. The engineer first asked for modifier combos as part of browser_key; the probe then tried seven parameter shapes (the CDP modifier bitmask, the boolean modifier fields, a single modifier field, an array of modifier names, and a rawKeyDown variant) and every one arrived at the page as an unmodified keydown, with ctrl, meta, shift and alt all false and the key itself trusted. A capability the page cannot observe is not a capability, so the combo clause came out of AC-4: keys are the named map and single characters, and a modifier argument is refused in plain words rather than sent as a key the page sees as unmodified. The named map, single characters, and Enter on a focused submit control all stay, because those are probe and self check verified.

The cross check (independently run on a second model) surfaced eight narrow gaps, and the engineer accepted all the recommended fixes: choose matches the label text first then the value attribute, browser_key accepts an optional ref that focuses first, the covered rule treats a hit on the target or its descendants as clear, the fill allow list is text like inputs plus textarea with contenteditable refused, refusals are plain text on the tool result, and a short quiet delay (300 ms default, a code constant) precedes the post action snapshot.

## Live probe record (2026-09-21, obscura 0.2.2)

The probe scripts live in scratch/probe-interact.ts and scratch/probe-interact2.ts (throwaway, not part of the plugin; safe to delete after the build).

Pass, verified end to end:

- Input.dispatchMouseEvent: mousePressed plus mouseReleased at a box center produced a click with isTrusted true.
- DOM.getBoxModel by backend node id returns the content quad in layout coordinates.
- Input.insertText after DOM.focus (or JS focus) inserts text; the input event fires with isTrusted true.
- Input.dispatchKeyEvent: Enter triggers the focused element's keydown path; char keys append text; modifier state is dropped (see the build task 3 record below).
- elementFromPoint returns the element at a point (the hit test).
- Runtime evaluate paths: el.click() works but fires untrusted events; the native value setter plus input event updates inputs and fires the change event on selects; scrollIntoView and window.scrollTo work; boxes re fetch correctly after scrolling, so the viewport conversion is a scrollX and scrollY subtraction.

Missing:

- DOM.pushNodesByBackendIdsToFrontend: unknown method (rules out frontend node resolution; not needed).
- DOM.getNodeForLocation: unknown method (hit tests go through elementFromPoint instead).
- DOM.getDocument returned no usable root nodeId in the probe; the querySelector path is not relied on.

Not probed at spec time: modifier combos (ctrl and meta plus a key) and caret placement after insertText. Build task 3 was to verify these first and append the result here; that probe has now run and is recorded below.

### Build task 3 probe record (2026-09-21, obscura 0.2.2)

Probe scripts: scratch/probe-modifiers.ts, scratch/debug-identity.ts, scratch/debug-cover3.ts, scratch/probe-keytext.ts, scratch/probe-keys-defaults.ts, scratch/probe-tab.ts (throwaway, safe to delete after the build).

Modifier state is dropped. The probe sent a keyDown for `a` in seven parameter shapes and the page's keydown listener saw the same thing every time: `{key:"a", ctrl:false, meta:false, shift:false, alt:false, trusted:true}`. None errored; the key arrives and is trusted, only the modifier state is lost. The shapes: `modifiers: 2` (the CDP bitmask), `modifiers: 8` (shift, with `key: a`), `ctrlKey: true`, `modifiers: 2` plus `ctrlKey: true`, `modifier: "ctrl"`, `modifiers: ["ctrl"]`, and `type: rawKeyDown` with `modifiers: 2`. Shift does not even change the reported key text. This is why AC-4 lost its modifier combo clause.

Caret after insertText is good. The self check drives fill then type on one input and reads back the appended value, so the focus plus setSelectionRange(n, n) path places the caret at the end (scratch/debug-submit.ts shows the same on the submit fixture).

Node identity needs isSameNode. DOM.resolveNode returns a distinct JS wrapper for the same node: on the resolved object, `this === document.getElementById("covered")` is false, `this.contains(live)` and `live.contains(this)` are both false, while `this.isSameNode(live)` is true and `nodeType` is 1. So every identity comparison goes through isSameNode, never === or contains, and the cover check walks up from the hit node comparing each step with isSameNode.

ElementFromPoint resolves in document order, not stacking order. Fixture: a fixed full width overlay with `z-index: 10` covering the top band, and a button inside that band. With the overlay earlier in the document than the button, elementFromPoint at the button's center returns the button, so the cover goes undetected (hit test read `BUTTON#covered` while the overlay's rect covered the point). With the overlay later in the document than the button, elementFromPoint returns the overlay and the click refuses, naming it: `[9] "Covered" is covered at its center by div#overlay; scroll it into view or dismiss the cover first, then click again`. The self check fixture therefore places the overlay last in the body. The check catches a cover that follows the target; a cover that precedes it is not detected, and the real fix is the engine's own hit test (DOM.getNodeForLocation) once it exists.

Where the mouse dispatch lands, verified. The check uses elementFromPoint, which ignores stacking order on this engine, so the open question was whether Input.dispatchMouseEvent has its own hit test that follows stacking order instead. It does not: the self check clicks a button that PRECEDES a covering overlay in document order, the cover check passes, and a document level capture listener records the click target as `blind`, the button itself (cover blind spot probe in scripts/interaction-selfcheck.ts). Both elementFromPoint and the dispatch resolve in document order, so the check and the click agree with each other and there is no silent mismatch between them. The residual limit is faithfulness, not a wrong report: a click can reach an element a person would see as covered, because the overlay the layout paints on top sits earlier in the document and neither hit path consults z index or paint order.

Character keys: the text belongs on the char event only. This engine inserts text carried on a keyDown as well as the text of a char event, so sending it in both places types the character twice: the first self check run landed `/` in the input as `//` (scratch/probe-keytext.ts). The verified shape is keyDown without text, then char with text, then keyUp, which lands the character once and still fires keydown with isTrusted true.

Named keys: delivered, mostly inert. Every named key reaches the page as a trusted keydown, but the engine performs a native action for only two of them (scratch/probe-keys-defaults.ts, run through the real tool). With the caret at position 2 of the value `abc`: Backspace deletes and moves the caret (value `ac`, caret 1), and Enter on a focused submit control submits (the probe landed on the Submitted page and the page saw the key as trusted). Delete, ArrowLeft, ArrowRight, Home, End, and Tab leave the value, the caret, and the focus untouched. With focus blurred and the page at the top, PageDown, ArrowDown, End, and PageUp leave scrollY at 0. So Tab does not traverse focus, the arrows, Home, End, and Delete do not move the caret, and no key scrolls. AC-4 as written promises delivery of the named key with trusted events and names exactly one native outcome (Enter submits), so this does not narrow AC-4; it records what the engine does with each key. The self check asserts both facts: the page sees `Tab:true`, and focus stays where it was. Page scrolling stays on browser_scroll (AC-6).