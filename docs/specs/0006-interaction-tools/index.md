# 0006. Interaction tools

**Date**: 2026-09-21
**Status**: Proposed

## Summary

The agent can now act on a page, not just read it: click, fill, type, choose from a select, scroll, and press keys, all addressed by the numbered references the read tool prints. Actions fire real trusted input events where the engine supports them, so pages see the same events a person produces. Every action ends by refreshing the element references, so the next action always works against an honest picture of the page.

## Requirements

**User stories**:
- As the agent, I want to click, fill, type, choose, scroll, and press keys on the page by reference number, so I can complete a multi step flow like searching, filling a form, and submitting it.
- As the agent, I want element references refreshed after each action, so I never act on a stale picture of the page.
- As the agent, I want failures in plain words with a next step, so a broken element never hangs a flow.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):

- **AC-1**: browser_click takes a ref from the latest read, scrolls the element into view, verifies its visible center is not covered by another element, clicks it with a trusted mouse event, waits for the page to settle, and reports the current URL and title plus fresh refs.
- **AC-2**: every action result carries fresh refs from a snapshot taken at the end of the action. A ref the fresh snapshot no longer contains is refused in plain words (stale: re read the page). After a navigation the refs describe the new page, never a stale one.
- **AC-3**: browser_fill replaces the input's value and browser_type appends to it, both through trusted text input. On an element that is not a text like input or a textarea (checkbox, radio, file, button, submit, select, hidden input, contenteditable region) they refuse, naming the element kind.
- **AC-4**: browser_key sends a named key (Enter, Tab, Escape, the arrows, Home, End, PageUp, PageDown, Backspace, Delete) or a modifier combo (ctrl, meta, shift, or alt plus one key) with trusted events to the active element, or to the element an optional ref focuses first; Enter on a focused submit control submits.
- **AC-5**: browser_choose sets a native select's value to a named option, matched by its label text first and then by its value attribute, and fires the change event; an option the select does not have is refused, listing the valid labels and values.
- **AC-6**: browser_scroll brings a ref into view or moves the page by a signed amount; the result reports the new scroll position.
- **AC-7**: every refusal names why and a next step: stale ref, covered element (the covering element is named; a hit on the target, a descendant of it, or its own boundary counts as clear), fill on a non text kind, choose to a missing option, engine down, timeout. Refusals are plain text on the tool result, not protocol errors. No action hangs: the 30 second clock and the caller's abort signal bound every call, carried from spec 0004.
- **AC-8**: a search, fill, and submit flow completes through the tools with refs honest at each step, proven by the self check against data: URLs (the engine refuses loopback fixtures).
- **AC-9**: browser actions run through the one supervisor queue and never interleave, carried from spec 0004.

## Decision

**Chosen option**: Option 1: trusted CDP input events primary, verified JS paths for the residuals (select value, scrolling), with refs only addressing, extended refs, settle then report, and fresh refs on every action.

One line: six browser tools (click, fill, type, choose, scroll, key) act on the read's fresh refs through trusted Input dispatch, verified live on this engine; select and scroll use the verified JS paths; every result carries fresh refs and the settled page's URL and title.

**Implementation skills**: `obscura` (`h4ckf0r0day/obscura`, `.agents/skills/obscura/`) · `pi-extension-authoring` (`romiluz13/pi-agent-skills`, `.agents/skills/pi-extension-authoring/`)

## Feature design

**Data model sketch**: no database, no persistence. Page state lives in the engine process (spec 0003). The ref contract from spec 0004 extends: each ref keeps kind, text, href, and backend node id, and adds the input's type (for inputs) and the option value list (for selects). A ref is still re derived from every snapshot at read time; nothing is stored between actions.

**State transitions**: not applicable. Actions run against the live page; the engine lifecycle (starting, ready, dead) is spec 0003's state machine, and the element references are re derived, not state.

**API surface**: six pi tools, no auth (the caller is the pi agent inside the pi process, the same trust as shell tools, carried from spec 0004). Every tool runs through `engine.runExclusive` and the error mapper with its four plain categories.

| Tool | Key inputs | Key outputs | Key errors |
| --- | --- | --- | --- |
| browser_click | ref: number (required) | element label, url, title, refs, scroll position | stale ref, covered element, engine down, timeout |
| browser_fill | ref: number (required), value: string (required) | element label, url, title, refs | stale ref, non text kind, engine down, timeout |
| browser_type | ref: number (required), text: string (required) | element label, url, title, refs | stale ref, non text kind, engine down, timeout |
| browser_choose | ref: number (required), value: string (required, matched by label text then value attribute) | element label, url, title, refs | stale ref, missing option (lists the valid labels and values), engine down, timeout |
| browser_scroll | one of: ref: number, or by: number (pixels, signed) | refs, scrollX, scrollY | stale ref, engine down, timeout |
| browser_key | key: string (required), ref: number (optional, focuses first), modifiers: string array (optional) | url, title, refs | unknown key name, engine down, timeout |

**Value sourcing** (every value each action produces, computes, or displays, and where it comes from):

| Action | Value produced / displayed | Source |
| --- | --- | --- |
| every action | the element a ref names | the fresh snapshot's backend node id, from the accepted every action freshness rule (not an input; the ref input maps through the fresh snapshot) |
| every action | element label shown in results | the fresh snapshot's ref text |
| click | visible center point | DOM.getBoxModel content quad of that backend node id, in layout coordinates minus the current scroll offset (probe fact: boxes are layout coordinates, dispatch wants viewport coordinates) |
| click | covered verdict, covering element | elementFromPoint at the center via evaluate, taken after the scroll and box re fetch (probe verified) |
| every action | fresh refs | DOMSnapshot.captureSnapshot after the settle wait and a short quiet delay (code constant, 300 ms default), plus the read serializer walk, spec 0004 |
| every action | settled verdict | the readyState poll and pageInfo from spec 0004 |
| every action | URL and title after the action | pageInfo after the readyState wait, spec 0004 |
| read (contract) | input kind and select option values | the extended ref contract in readPage, this spec |
| fill, type | inserted text | Input.insertText after DOM.focus or JS focus on the element (probe verified trusted) |
| fill (clear first) | cleared value | focus, select all, insertText replacement, the sequence verified at build task 3 |
| key | focused element | the optional ref input, else the active element |
| key | key event | Input.dispatchKeyEvent with the named key map, a code constant |
| choose | select value and change event | native value setter plus a bubbled change event via evaluate (probe verified) |
| choose | matching a named option | label text first, then the value attribute, against the ref's option list from the fresh snapshot |
| choose | valid option list | the ref's option values from the fresh snapshot |
| scroll | movement and position | window.scrollTo, scrollIntoView, scrollX and scrollY via evaluate (probe verified) |
| every tool | timeout verdict | the 30 second tool clock, a code constant (spec 0004) |
| every tool | engine down verdict | the supervisor state machine, spec 0003 |

**Key invariants**:
- All browser CDP work runs through the one queue; actions never interleave with reads (carried).
- A ref is always a backend node id from the latest action's or read's snapshot; an action never trusts an older ref silently.
- Before a mouse event, the element's visible center is validated: scrolled into view, re fetch the box, then elementFromPoint (a hit on the target, a descendant of it, or its own boundary counts as clear; anything else refuses, naming the cover).
- Trusted events are the primary path where the engine supports them (Input domain methods, probe verified); untrusted JS events appear only in the residual paths (select value, scroll), never as the primary click or typing path.
- No action hangs: bounded by the caller's abort signal and 30 seconds (carried).

**Security model**: unchanged from spec 0004: single actor (the pi agent inside the pi process under the user's account), no roles, no tenants, no regulated data. The engine binds loopback and refuses private and loopback navigation itself, so the browser surface cannot be pointed at internal services. The action surface sits in the same trust domain as shell tools; no credentials. Action results report the element label and where the page is, never page contents, so nothing sensitive is logged.

**Configuration required**: none new as environment or config. Two code constants join the existing ones: the named key map, and the quiet delay before the post action snapshot (300 ms default). The spec 0004 follow up that turns the timeouts and caps into config is still open.

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: read a page, click a button by ref, fill a field, type into another, press Enter, read the settled result; refs fresh at every step. Verifies **AC-1**, **AC-3**, **AC-4**, **AC-8**.
- Freshness: read, click a link that navigates, then pass a ref from before the navigation; refused in plain words, and the new page's refs are available. Verifies **AC-2**.
- Failure: fill on a checkbox ref refuses naming the kind; choose a missing option refuses listing the valid ones; a button whose center is covered by a fixed header refuses naming the cover. Verifies **AC-3**, **AC-5**, **AC-7**.
- Concurrency: several browser calls at once; the queue serializes them (carried behavior, rechecked for actions). Verifies **AC-9**.

## Build plan

Built against the real engine, per Tracer Bullet: one thin end to end thread first (a click on a real page through the real engine), then thicken each strand. Every task names the AC it satisfies.

1. [ ] Refs contract extension and action core: readPage refs add the input's type and the select's option values; shared element helpers resolve a ref in the fresh snapshot, read the box center, convert layout to viewport coordinates, and scroll the element into view. Satisfies **AC-2**, **AC-6**.
2. [ ] Click strand: scroll into view, re fetch the box, elementFromPoint cover check (a hit on the target or a descendant counts clear, else refuse naming the cover), trusted mouse press and release at the center, settle wait, quiet delay, fresh refs. Satisfies **AC-1**, **AC-2**, **AC-7**.
3. [ ] Typing strand: opens by extending the capability probe to verify modifier combos and caret behavior, recording the result in the rationale probe record. Then DOM focus then Input.insertText, clear first for fill (focus, select all, insertText replacement), char keys, and the browser_key named map with Enter, Tab, Escape, the arrows, and modifier combos. Satisfies **AC-3**, **AC-4**, **AC-7**.
4. [ ] Choose and scroll strands: select value via the verified JS setter plus change event, options matched by label text first then value attribute; browser_scroll in the ref and the amount forms. Satisfies **AC-5**, **AC-6**, **AC-7**.
5. [ ] Tool wiring and self check: register the six tools through the queue with abort and timeout bounds and the error mapper; scripts/interaction-selfcheck.ts proves the search, fill, submit flow and the refusal cases against data: URLs. Satisfies **AC-1**, **AC-3**, **AC-4**, **AC-5**, **AC-8**, **AC-9**.

## Consequences

**Positive**:
- The agent completes multi step flows entirely through pi tools: search, fill, submit, no step where it can only read.
- Trusted events: pages see the same click and typing events a person produces, so framework inputs and bot detection behave (probe verified isTrusted true).
- Refs stay honest by construction: every action returns fresh refs, so a stale ref is refused, never silently acted on.
- Real engine behavior is recorded, not assumed: the missing methods (pushNodesByBackendIdsToFrontend, getNodeForLocation) are documented so the next slice does not rediscover them.

**Negative / tradeoffs**:
- Untrusted JS events for select and scroll: a page that verifies the user gesture on those specific paths could misbehave; click, typing, and keys all use the trusted path.
- One extra DOM snapshot per action (the freshness refresh), the same cost browser_read already pays; on very large pages that is a few moments per step.
- Refusals are strict: a click whose center is covered is refused even when a human might click nearby; the agent must scroll or dismiss the cover first.
- The settle wait after every action can take up to the 30 second bound on a slow page, the same bound reads already carry.

**Neutral**:
- The key map, scroll behavior, and the 60000 character cap remain code constants; the spec 0004 follow up about owning timeouts and caps as config is still open.
- The quiet delay before the post action snapshot is a heuristic (a code constant): a page still changing when it elapses can snapshot mid change, the same limit every snapshot has.
- The read output grows slightly (input types and select options in refs), a contract addition to spec 0004.
- If the engine later adds trusted wheel events or hit testing, the verified JS paths can graduate to trusted events without a surface change.

## Follow-up

- [ ] /check verify interaction tools next; verify.md beside this spec is its checklist.
- [ ] The stale ref refusal reads the fresh snapshot; if a page re renders between the action and the snapshot, a ref can look stale once. The self check rechecks it; a watch item only.
- [ ] browser_choose covers native selects only; custom combo widgets go through click on the fresh refs. Flagged for slice 3 if a widget type needs its own path.
- [ ] contenteditable regions are refused by fill and type today; a rich text editing path could come later if a workflow needs it.
- [ ] The spec 0004 follow up still open: timeout constants and the truncation cap become feature 3 configuration.
- [ ] Scroll and key behavior are code constants; when the engine supports trusted wheel events, graduate scroll to Input dispatch (watch item).

## Rationale

Reasoning and options: see [rationale.md](rationale.md).