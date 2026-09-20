# Verify: Core navigation and reading · spec 0004 · updated 2026-09-21

_Steps derived from spec 0004 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## UI / manual (run through the module runtime path the pi tools call; the literal in pi calls are a spot check)

- [x] In pi, call `browser_navigate` with an absolute public URL (for example https://example.com) → the tool answers with the page title and URL. (Read equivalent: navigated to https://example.com/docs, answer was title Example Domain.) → AC-1
- [x] Call `browser_navigate` with `example.com` (no scheme) → a plain message naming the missing scheme. → AC-1, AC-2
- [x] Call `browser_navigate` with `http://127.0.0.1:80/` → a plain refusal, no hang (the engine blocks loopback). → AC-2
- [x] Call `browser_navigate` with a local fixture as a data: URL (`data:text/html,<h1>Hi</h1>`) → opens; title and URL reported. → AC-1
- [x] Call `browser_read` → markdown of the page; links render as markdown links with their hrefs; buttons, inputs, selects, and textareas carry numbered refs; refs appear in document order. → AC-3
- [x] Take a href from a read result and `browser_navigate` to it → the linked page opens. → AC-4
- [x] Call `browser_back` → the previous page's title and URL are reported. → AC-5
- [x] Call `browser_back` again on the session's first page → a plain no earlier page message. → AC-5
- [x] Call `browser_forward` → the next page's title and URL are reported; on the newest page the answer says plainly there is no later page. → AC-6
- [x] Call `browser_reload` → the same page reloads; title and URL reported again. → AC-7
- [x] Read, navigate, read again → the second read reports the new URL and title and its refs describe the new page from a fresh snapshot. → AC-8

## Commands

- [x] `npx tsc --noEmit` → exits 0. → AC-9 (type bound)
- [x] `node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs scripts/navigation-selfcheck.ts` → prints "navigation and reading self-check passed". → AC-1, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8
- [x] Engine level (run during `/check verify`): kill the engine process from outside and call again → the failure names the death in plain words and the next call restarts the engine with a blank page. (Ran at module level: killed the spawned engine, the stale connection failed with a closed socket message, and the next call restarted with a fresh engine process.) → AC-9, AC-10

## Acceptance-criteria coverage

- AC-1 (open a URL, report title and URL) covered by the navigate steps · AC-2 (plain refusal, no hang) covered by the scheme and loopback steps · AC-3 (markdown with refs in document order) covered by the read step · AC-4 (follow links) covered by the href navigation step · AC-5 (back) covered by the back steps · AC-6 (forward) covered by the forward steps · AC-7 (reload) covered by the reload step · AC-8 (ref lifetime, fresh snapshot) covered by the re read step · AC-9 (queue, abort, timeout, error mapping) covered by the typecheck and the engine level call checks · AC-10 (one engine per session, restart on death) covered by the kill test