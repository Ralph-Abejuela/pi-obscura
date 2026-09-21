# Verify: session state · spec 0008 · updated 2026-09-21
_Steps derived from spec 0008 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

Two steps need a real `cf_clearance` cookie earned by a browser the site accepts, which this plugin cannot produce. Everything else runs against `data:` URLs and one real origin, because the engine refuses loopback fixtures.

## UI / manual
- [x] In a pi session, `browser_cookies` with `action: "import"` and the path of a cookie export file → the report reads `Imported N cookie(s)` and names the profile directory → AC-1
- [x] The same listing through `browser_cookies` with `action: "list"` → each cookie shows its name, domain, path, expiry and flags, and the value reads `<redacted>` → AC-3
- [x] `action: "list"` with a domain → only that domain's cookies are listed, and a domain with none reports `No cookies` rather than an empty list → AC-3
- [x] `action: "clear"` with a domain → the report counts the cookies cleared, and a following list is empty for that domain while another domain is untouched → AC-3
- [x] `action: "import"` with no `path` → refused, naming what is missing → AC-5
- [x] `action: "purge"` (or any unknown action) → refused, naming list, import and clear → AC-5
- [x] Point `path` at a file that does not exist, then at a file that is not JSON, then at JSON that is not a cookie export, then at an export whose second entry has no value → each refuses in plain words naming the entry and the field, and a list afterwards shows the jar unchanged → AC-5
- [x] Search every one of those outputs for the cookie's real value → it appears nowhere, including the import report, the listing, the config view and the status line → AC-4
- [x] `/browser-config` → shows `profileDir` with its effective value and says the profile holds the jar as plain text → AC-6
- [x] `/browser-config set profileDir <a path>` then `set profileDir` with an empty value → the first pins the path, the second returns it to the default, and each report names what changed → AC-6
- [x] Set `profileDir` to a path that cannot be created (for example a path under a file) and call a browser tool → the failure names the `profileDir` setting and how to fix it, rather than surfacing as an engine problem → AC-6
- [x] `/browser-cookies list [domain]`, `import <path>` and `clear [domain]` → the command says the same things the tool does, and the status line shows `cookies: <action>` while it works → AC-3
- [x] Open a Cloudflare protected page (for example `https://ph.jobstreet.com/jobs-in-information-communication-technology`) → the result says it is a bot challenge page, names the reason and points at `browser_cookies`, instead of looking like a normal page → AC-7
- [x] Import a real `cf_clearance` cookie exported from your own browser right after it passed the challenge, then open the protected page again → record what actually happens. Either outcome is a valid result; a challenge still standing is the honest one to report → AC-7

## Commands
- [x] `npm run typecheck` → clean → build gate
- [x] `npm run lint` → clean → build gate
- [x] `node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs scripts/session-selfcheck.ts` → `session state self-check passed` → AC-1 to AC-6, AC-8
- [x] `node .../jiti-cli.mjs scripts/config-selfcheck.ts` → passes, including the profileDir cases → AC-6
- [x] `node .../jiti-cli.mjs scripts/navigation-selfcheck.ts`, `scripts/interaction-selfcheck.ts` and `scripts/script-selfcheck.ts` → all pass, proving the spawn line change and the new stop settle changed nothing for the slice 1 to 3 tools → no regression

## Value sourcing coverage
Each row of the spec's value sourcing table, and the edge that would break if the source were wrong.
- [x] The imported fields come from the export file and nowhere else: import a file with a distinctive domain, then list → that domain and no other → AC-1
- [x] The imported count comes from what the engine accepted: import three cookies → `Imported 3 cookie(s)`, and the listing shows three → AC-1
- [x] The listing rows come from the engine's jar: set a cookie through the tool's import, then read the same jar with the engine's own tooling (or a second process) → the same cookie appears in both → AC-3
- [x] The redacted marker is a constant, so no value is ever read into a row: list a jar holding a cookie whose value is a distinctive string, and confirm the string appears in nothing the plugin returns → AC-4
- [x] The profile path shown in reports comes from the `profileDir` setting: change it, then list → the new path is the one printed → AC-6
- [x] The cleared count comes from the cookies the jar actually held for that domain: clear a domain twice in a row → the first reports a count, the second reports zero → AC-3
- [x] The challenge verdict comes from the page after navigation: open a normal page and a challenge page → only the challenge one carries the note, and the note only fires on the challenge title → AC-7
- [x] The persisted jar comes from the engine's own profile file: after a set and a clean stop, read `<profileDir>/cookies.json` → the cookie is in it → AC-2

## Acceptance-criteria coverage
- AC-1 covered by the import steps, the import-count sourcing step and the distinctive-domain step
- AC-2 covered by the restart step in the session self check and the profile-file sourcing step
- AC-3 covered by the list, domain filter and clear steps plus the cleared-count sourcing step
- AC-4 covered by the search-every-output step and the redacted-marker sourcing step
- AC-5 covered by the no-path, unknown-action and four bad-file steps
- AC-6 covered by the config view, set, clear, bad-path steps and the profile-path sourcing step
- AC-7 covered by the challenge page step and the real cookie step
- AC-8 covered by the session self check, which runs the import, the restart, the redacted list, the filtered clear and every refusal

## Known gaps
- The real session case ran on 2026-09-21 and was **refused**. A 14 cookie export from an incognito browser that had passed the challenge (`cf_clearance` and `__cf_bm`, plus the site's own `JobseekerSessionId` and `JobseekerVisitorId`) was converted from the browser's Netscape format, imported through `browser_cookies`, and listed redacted, and the protected listing still served Cloudflare's interstitial with 0 job cards and no links. The plugin carried the session exactly as designed, so this is an engine limit and not a cookie path problem: the TLS hello carries no GREASE and the engine has no WebGL, so a clearance earned by a real browser is refused when it arrives on a connection Cloudflare does not recognise. Reaching that site through this plugin needs a better engine fingerprint or a real browser, not a better cookie path.
- The engineer's own export is Netscape `cookies.txt`, which the approved design does not accept: its two shapes are JSON (a bare list, or an object carrying a list). The test converted the file in a throwaway driver. Accepting the Netscape format is a small addition and it is what most browser extensions export by default, so it is the obvious next widening of AC-5.
- The engine still refuses to persist a jar written while the connection is open: the jar reaches disk when the CDP socket closes, so a process killed without a clean close loses the session. The plugin closes first and settles 300 ms (`SESSION_FLUSH_MS`), which the self check proves, but a hard kill outside the plugin still loses it.
