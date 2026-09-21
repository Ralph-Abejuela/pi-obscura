# Verify: Interaction tools · spec 0006 · updated 2026-09-21

_Steps derived from spec 0006 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## UI / manual (run through the module runtime path the pi tools call; the literal in pi calls are a spot check)

- [ ] In pi, call `browser_read` on a fixture page (data: URL with a button, a text input, a select, a textarea, a link) → the refs list the elements; an input ref now names its type and a select ref lists its option values. → AC-2
- [ ] Call `browser_click` with a button's ref → the click lands on the button; the result reports the element label, the current URL and title, and fresh refs. → AC-1, AC-2
- [ ] Call `browser_click` on a link ref → the page navigates; the result reports the new URL and title and the fresh refs describe the new page. → AC-1, AC-2
- [ ] Call `browser_click` on a ref whose center another element covers (for example a fixed header overlapping the target) → a plain refusal naming the covering element. → AC-1, AC-7
- [ ] Call `browser_click` on a target whose center lands on one of its own descendants (for example a button with a nested span) → the click lands on the button, counted as clear. → AC-1, AC-7
- [ ] Call `browser_fill` on a text input ref with a value → the input shows exactly that value (replaced). → AC-3
- [ ] Call `browser_type` on the same input ref with more text → the value appends; the fresh read reflects it. → AC-3
- [ ] Call `browser_fill` on a checkbox or select ref, or on a contenteditable region → a plain refusal naming the kind. → AC-3, AC-7
- [ ] Call `browser_key` with Enter while a submit button is focused → the form submits (or the button's click path fires); the result settles and reports. → AC-4
- [ ] Call `browser_key` with Enter plus the submit button's ref → the same submit without a prior type into it. → AC-4
- [ ] Call `browser_key` with Tab → focus moves; with an unknown key name → a plain unknown key refusal. → AC-4, AC-7
- [ ] Call `browser_choose` on a select ref with an option's label text → matched to its value and the change event fires; with the value attribute → also matched; with a bogus option → a refusal listing the valid labels and values. → AC-5, AC-7
- [ ] Call `browser_scroll` with a ref far down the page → the element scrolls into view; call it with a signed amount → the window moves by that amount; both report scrollX and scrollY. → AC-6
- [ ] Read, click a link, then pass a ref from before the navigation → a plain stale refusal telling the agent to re read. → AC-2, AC-7

## Commands

- [ ] `npx tsc --noEmit` → exits 0. → AC-9 (type bound)
- [ ] `node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs scripts/interaction-selfcheck.ts` → prints "interaction tools self-check passed". The self check proves the search, fill, submit flow (type into a search box, click a result button, fill a form field, press Enter to submit), each step asserting fresh refs, plus the refusal cases (stale ref, covered element, fill on a checkbox, choose to a missing option) against data: URLs. → AC-1, AC-3, AC-4, AC-5, AC-8
- [ ] Engine level (run during `/check verify`): kill the engine process mid flow and call an action → the failure names the death in plain words and the next call restarts the engine with a blank page. → AC-7, AC-9

## Acceptance-criteria coverage

- AC-1 (trusted click, scroll into view, cover check, settle, report URL and title plus fresh refs) covered by the button and link click steps and the covered element step · AC-2 (fresh refs every action, stale refusal) covered by the after navigation refusal step and each action's fresh refs assertion · AC-3 (fill replaces, type appends, non text refusal) covered by the fill, type, and checkbox steps · AC-4 (named keys and combos, Enter submits) covered by the key steps · AC-5 (choose sets value with change event, missing option refused with valid list) covered by the choose steps · AC-6 (scroll a ref into view or by amount, report position) covered by the scroll steps · AC-7 (plain refusals with next step, bounded by the 30 second clock) covered by every refusal step and the engine level check · AC-8 (multi step flow end to end) covered by the self check · AC-9 (one queue, abort, timeout, error mapping) covered by the typecheck and the engine level call checks