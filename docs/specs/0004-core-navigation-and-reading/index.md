# 0004. Core navigation and reading

**Date**: 2026-09-21
**Status**: Accepted

## Summary

This feature gives the pi agent the browsing loop the plugin exists for: open a URL, read the page as markdown with numbered references for the interactive elements, follow links, and move back, forward, and reload, all through pi tools. Spec 0001 fixed the architecture (raw CDP, one persistent connection, DOM snapshot reading, backend node ID references) and this spec records how that plays out against the real engine and pins the five tool surface. The engine diverges from Chrome assumptions in three places, all measured live before the build: it starts with no page target, it has no Page.goBack, and its snapshot returns a shared strings array. The build is done and passes its own end to end check against the real engine; this spec documents that reality and carries the acceptance criteria and verify steps.

## Requirements

**User stories**:
- As the agent, I want to open any page and see it as readable text with the interactive elements referenced, so I can understand a page and decide what to do next.
- As the agent, I want to move around a session's pages (follow a link, go back, go forward, reload) without redoing prior steps.
- As the agent, I want failures in plain words with a next step, so a blocked or broken page never hangs a call.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):

- **AC-1**: browser_navigate opens an absolute URL, waits for the page to finish loading, and reports the page's title and current URL. A URL missing its scheme is refused with a message that names the fix.
- **AC-2**: a navigation the engine refuses or that fails (including private and loopback addresses) returns a plain message naming the problem, never a hang.
- **AC-3**: browser_read returns the current page as markdown. Interactive elements get numbered references in document order: links render as markdown links carrying their href, buttons, inputs, selects, and textareas render with their ref number, and every ref maps to a distinct CDP backend node ID.
- **AC-4**: the hrefs in a read result can be followed; navigating to one opens that page.
- **AC-5**: browser_back moves to the previous page in the engine's history and reports its title and URL; with no earlier page it says so plainly.
- **AC-6**: browser_forward moves to the next page in the engine's history and reports its title and URL; with no later page it says so plainly.
- **AC-7**: browser_reload reloads the current page and waits for it to load again.
- **AC-8**: every read takes a fresh snapshot, so refs always describe the page the agent just saw; the read reports the URL and title it read, and after any navigation the refs describe the new page, never a stale one.
- **AC-9**: concurrent browser tool calls never interleave CDP work (one queue), and every call is bounded by the caller's abort signal and a 30 second timeout; errors map to four plain categories (engine down, page error, protocol unsupported, timeout) each with a next step.
- **AC-10**: the whole slice runs on one engine process per session; a dead engine fails the in flight call in plain words and the next call starts a fresh engine (inherited from spec 0003).

## Decision

**Chosen option**: Option 1, the reading loop over raw CDP as specced in 0001, with the three engine realities recorded as decisions (create the session page, traverse history through the engine's own entries, read from the shared strings snapshot).

One line: five `browser_` tools (navigate, read, back, forward, reload) run inside the supervisor queue against the one session page, bound by abort and 30 seconds, with errors mapped to plain categories.

**Implementation skills**: `obscura` (`h4ckf0r0day/obscura`, `.agents/skills/obscura/`) · `pi-extension-authoring` (`romiluz13/pi-agent-skills`, `.agents/skills/pi-extension-authoring/`)

## Feature design

**Data model sketch**: no database, no persistence. The page state and the history stack live in the engine process for the life of the session (spec 0003). Module state in the extension: the supervisor's engine state (phase, client, sessionId, queue) and nothing else. A ref is not stored state; it is re derived from every snapshot at read time.

**State transitions**: not applicable in the spec's own data. The page lifecycle (starting, ready, dead) is spec 0003's state machine. The engine's own navigation history is the only traversable history; this slice does not keep a parallel stack.

**API surface**: five pi tools, no auth (the caller is the pi agent inside the pi process, the same trust as shell tools). Every tool runs through `engine.runExclusive(signal, fn)` so CDP work never interleaves, and through the error mapper with its four plain categories.

| Tool | Key inputs | Key outputs | Key errors |
| --- | --- | --- | --- |
| browser_navigate | url: string (required, absolute) | title, url, frameId | scheme missing or invalid URL, engine refusal, engine down, timeout |
| browser_read | none | markdown, url, title, refs, truncated | engine down, empty snapshot, timeout |
| browser_back | none | title, url | no earlier page, engine down |
| browser_forward | none | title, url | no later page, engine down |
| browser_reload | none | title, url | engine down, timeout |

Internal surface added on top of spec 0003: `runExclusive` (the shared queue) on the supervisor, and the session page created at connect via `Target.createTarget` then `Target.attachToTarget` (the engine lists no page target until one exists, verified live on 0.2.2).

**Value sourcing** (every value each action produces, computes, or displays, and where it comes from):

| Action | Value produced / displayed | Source |
| --- | --- | --- |
| browser_navigate | the URL to open | tool input, validated absolute (scheme required) |
| browser_navigate | load finished verdict | engine document.readyState polled until complete |
| browser_navigate | reported title and URL | engine document.title and location.href after load |
| browser_navigate | refusal verdict and text | engine Page.navigate rejection or errorText |
| browser_read | markdown body | serializer over the engine DOMSnapshot.captureSnapshot response (shared strings array, nodes tree by parentIndex) |
| browser_read | ref numbers | count of interactive elements in document order during the walk |
| browser_read | ref node IDs | engine backendNodeId per snapshot node |
| browser_read | href text | engine attribute values in the snapshot |
| browser_read | reported URL and title | engine snapshot documentURL and title string indexes |
| browser_read | truncation flag | the 60000 character cap applied during serialization |
| browser_back / browser_forward | the target history entry | engine Page.getNavigationHistory currentIndex minus one (back) or plus one (forward) |
| browser_back / browser_forward | no entry verdict | engine history bounds, currentIndex at an edge |
| browser_back / browser_forward | moved page title and URL | engine after Page.navigateToHistoryEntry, same readyState wait |
| browser_reload | reloaded page title and URL | engine after Page.reload, same readyState wait |
| every tool | timeout verdict | the 30 second tool clock, a code constant (feature 3 owns it later) |
| every tool | engine down verdict | the supervisor state machine (spawn, exit, socket close), spec 0003 |

**Key invariants**:
- All browser CDP work runs through one queue; CDP calls never interleave.
- A ref is always a backend node ID from the latest read's snapshot.
- At most one engine process per session, no per call spawn.
- No tool call hangs: every call is bounded by the caller's abort signal and 30 seconds.
- The plugin never kills an engine process it did not spawn (from spec 0003).

**Security model**: single actor, the pi agent, inside the pi process under the user's account; no roles, no tenants, no regulated data, nothing sensitive logged. The engine binds loopback and refuses private and loopback navigation itself, so the browser surface cannot be pointed at internal services; public http(s) pages plus data:, file:, and about: URLs are reachable. No new trust boundary, no credentials.

**Configuration required**: none new. The timeout and truncation cap are code constants today (feature 3, plugin state and configuration, later owns them as config; carried from spec 0003).

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: navigate a page, read it, follow a link href from the read, go back, go forward, reload, read again. Verifies **AC-1**, **AC-3**, **AC-4**, **AC-5**, **AC-6**, **AC-7**.
- Failure case: navigate to a private address (for example http://127.0.0.1:80/) or to a URL without a scheme; the tool answers in plain words without hanging. Verifies **AC-2**.
- Concurrency: several browser tool calls at once; the queue serializes them and each settles with its own answer and its own timeout bound. Verifies **AC-9**.
- Ref freshness: read, navigate, read again; the second read's refs describe the new page from a fresh snapshot, and the read reports the new URL and title. Verifies **AC-8**.
- Death: kill the engine process mid session; the in flight call fails in plain words and the next call starts a fresh engine with a blank page. Verifies **AC-10**.

## Build plan

Built and verified against the real engine; every task below is done and ticked so a resume never rebuilds it.

1. [x] Supervisor page session and queue: create the one session page at connect (Target.createTarget, then attachToTarget) and add runExclusive so all browser work serializes. Satisfies **AC-1**, **AC-9**.
2. [x] Navigation operation: validate the URL, Page.navigate, wait for readyState complete, report the engine's title and URL, surface engine refusals in plain words. Satisfies **AC-1**, **AC-2**.
3. [x] Reading operation: capture the DOM snapshot, serialize to markdown with interactive refs in document order mapped to backend node IDs, truncate at 60000 characters. Satisfies **AC-3**, **AC-4**, **AC-8**.
4. [x] History operations: back and forward through Page.getNavigationHistory plus Page.navigateToHistoryEntry, with plain edge messages. Satisfies **AC-5**, **AC-6**.
5. [x] Reload operation: Page.reload plus the readyState wait. Satisfies **AC-7**.
6. [x] Tool wiring: register the five browser tools through the queue with abort and timeout bounds and the four category error mapper. Satisfies **AC-9**.
7. [x] Self check: scripts/navigation-selfcheck.ts proves the loop end to end against the real engine using data: URLs (the engine refuses loopback fixtures). Satisfies **AC-1**, **AC-3**, **AC-4**, **AC-5**, **AC-6**, **AC-7**, **AC-8**.

## Consequences

**Positive**:
- The agent can open, read, move around, and revisit pages entirely through pi tools, with one supervised engine per session.
- Reads are deterministic: no page scripts run, and refs map to nodes the agent actually saw.
- The engine realities that diverge from Chrome (no listed page target, no Page.goBack, shared strings snapshot) are recorded decisions now, not build surprises for the next slice.
- The tool surface stays generic (`browser_` prefix), so a future engine swap does not rename tools (from spec 0001).

**Negative / tradeoffs**:
- Read fidelity is plain markdown: no bold or italic, tables flatten to lines, iframes are skipped (main frame only), and content truncates at 60000 characters.
- The read is a DOM snapshot, not a rendered view: elements a human would not see (hidden by styling, offscreen) can appear in the markdown.
- The engine refuses private and loopback addresses, so local fixtures and testing must use data: URLs or public hosting; the plugin cannot browse the engineer's internal network through this surface.
- History rides on the engine's own history entries; verified working on 0.2.2, but a future engine release could change it (watch item, follow-up).
- A dead engine loses the page; the next call starts fresh, the agent re reads (accepted in spec 0003).

**Neutral**:
- Timeout constants and the truncation cap are code values today; feature 3 (plugin state and configuration) turns them into config.
- The ref contract fixed here (backend node ID per ref, fresh per snapshot) is what the interaction tools (feature 7) consume.

## Follow-up

- [ ] /check verify core navigation and reading next; verify.md beside this spec is its checklist.
- [ ] Timeout constants and the truncation cap become feature 3 configuration (carried from spec 0003).
- [ ] Watch item: back and forward ride on Page.getNavigationHistory and Page.navigateToHistoryEntry. If a future engine release drops them, fall back to a plugin side URL stack.
- [ ] Root AGENTS.md does not exist; /audit (feature 2) should record the obscura and pi-extension-authoring skills in its agent skills section (carried from specs 0001 and 0003).
- [ ] The interaction tools (feature 7) resolve refs by backend node ID as defined here, and page reads between actions refresh them.

## Rationale

Reasoning and options: see [rationale.md](rationale.md).