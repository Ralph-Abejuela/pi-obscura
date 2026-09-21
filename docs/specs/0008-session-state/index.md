# 0008. Session state: a saved profile and imported cookies

**Date**: 2026-09-21
**Status**: In Progress

## Summary

The plugin can keep a real browsing session. It passes a profile directory to the engine, so the cookies the engine earns survive between runs, and it lets you import cookies from your own browser so a site that checks for a real session accepts the engine. Both halves ride the connection the plugin already has: no new transport, no new dependency. The one limit stays honest: an imported session is what gets you past a challenge, not a better fingerprint.

## Requirements

**User stories**:
- As the agent, I want to carry a session cookie into the browser, so I can reach a site that refuses a browser with no history.
- As the agent, I want the cookies the engine earns to survive a restart, so a session I established once keeps working.
- As the agent, I want to see which cookies exist for a site without ever printing their values, so I can debug a session without leaking it.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):

- **AC-1**: cookies imported from a file are live in the running page. The agent points the tool at an export file; every valid entry is set for its domain, and the page's own `document.cookie` shows the names it is allowed to see.
- **AC-2**: cookies survive a restart. With the profile directory configured, a cookie set in one engine process is present in the jar of the next one, proven by reading the jar from a second process.
- **AC-3**: the agent can list the cookies for a site and clear them. The list reports each cookie's name, domain, path, and flags, and reports the value as redacted. Clearing removes the site's cookies and reports how many went.
- **AC-4**: no cookie value ever appears in a tool result, a status line, a notification, or an error message. Only names, counts, domains, and flags do. The profile directory is created with owner only permissions where the operating system supports it, and the report says in plain words that the file holds session cookies in plain text.
- **AC-5**: a bad import is refused in plain words before anything is written: a missing file, unreadable JSON, an unrecognised shape, an entry with no name or no value, and an unknown action each name what to fix. An import is all or nothing, so a refused import leaves the jar untouched.
- **AC-6**: the profile directory is a per key validated setting like every other plugin setting, with a documented default, visible and changeable through the existing config surface, and a change takes effect at the next engine start.
- **AC-7**: a challenge page is reported honestly. When the page is a bot challenge the tool says so and names the likely reason and the next step, and the Cloudflare class is a measured outcome with an imported session, reported as what happened rather than promised.
- **AC-8**: proven by the self check against `data:` URLs plus one real origin for the cookie work (the engine refuses loopback fixtures): an import that lands, a restart that keeps a cookie, a redacted list, a clear, every refusal, and the honest challenge verdict.

## Decision

**Chosen option**: Option 1: keep the CDP connection, and build the session on the cookie and storage methods the engine already answers, plus the engine's own profile directory flag.

One line: the plugin gains a `profileDir` setting passed to the engine as `--storage-dir`, a cookie tool that sets, lists redacted, and clears cookies over `Network` and `Storage` CDP methods it already reaches, and an import from a cookie export file that is all or nothing; the profile keeps the jar between runs, and no cookie value is ever printed.

**Implementation skills**: `obscura` (`h4ckf0r0day/obscura`, `.agents/skills/obscura/`) · `pi-extension-authoring` (`romiluz13/pi-agent-skills`, `.agents/skills/pi-extension-authoring/`)

## Feature design

**Data model sketch**: no database. Two named shapes and one file on disk. A **cookie entry** is `{ name, value, domain, path, secure?, httpOnly?, sameSite?, expires? }`, the shape the engine's own jar uses. An **import report** is `{ imported: number, refused: number, reason?: string }`. The file on disk is the engine's own `cookies.json` inside the profile directory, a plain JSON array of cookie entries, written by the engine and never by the plugin. Nothing else is stored: no plugin owned cookie cache, no shadow copy that could drift from the engine's jar.

**State transitions**: not applicable beyond the engine's existing lifecycle (spec 0003). One new input to `startEngine`: the effective `profileDir` becomes `--storage-dir`.

**API surface**: one new tool, one new command, one new setting. No auth: the caller is the pi agent inside the pi process, the same trust as shell tools (carried from spec 0004).

| Surface | Key inputs | Key outputs | Key errors |
| --- | --- | --- | --- |
| `browser_cookies` tool | `action: "list" \| "import" \| "clear"` (required); `domain: string` (optional, filters list and clear); `path: string` (required for `import`, the export file) | the redacted cookie list, or `imported` and `refused` counts, or the number cleared, with the profile path | a missing or unreadable file, unreadable JSON, an unrecognised shape, an entry without a name or a value, an unknown action, engine down, timeout |
| `/browser-cookies` command | `list [domain]` · `import <path>` · `clear [domain]` | the same reports, in the status line and a notification | the same refusals, in plain words |
| `profileDir` setting | a path string | the effective path in the config view | a path that cannot be created, in plain words with the setting name |

**Value sourcing** (every value each action produces, computes, or displays, and where it comes from):

| Action | Value produced / displayed | Source |
| --- | --- | --- |
| import | each cookie's fields | the export file entry (the caller's own session), never invented and never fetched by the plugin |
| import | `imported` count | derived: entries the engine accepted, from `Network.setCookie`'s `success` |
| import | `refused` count and reason | derived: the first entry that failed validation before any write |
| list | the cookie rows | `Network.getAllCookies` (filtered by domain when given) |
| list | the redacted value | a code constant, so the real value is never read into the result at all |
| clear | the number cleared | `Network.deleteCookies` per entry, counted |
| all | the profile path | the `profileDir` setting, defaulted by a code constant |
| all | the profile's permissions | the permission call the plugin made, reported as what it did |
| challenge verdict | whether the page is a challenge | derived from the page's title and text after navigation, plus the reachability of the requested host |
| all | the engine down verdict | the supervisor state machine, spec 0003 |

**Key invariants**:
- **The transport does not change.** The engine answers `Network.setCookie`, `Network.getCookies`, `Network.getAllCookies`, `Storage.getCookies` and `Storage.setCookies` on the connection the plugin already holds, so this feature adds no second protocol and no new dependency (probe verified).
- **A cookie value never reaches output.** Not in a tool result, a status line, a notification, an error, or a log line. Only names, counts, domains, paths, and flags do.
- **The profile holds credentials in plain text**, so its permissions are the protection: the directory is created owner only where the OS supports it, and every report that names the path says plainly that session cookies live there unencrypted.
- **An import is all or nothing**: every entry is validated before the first is written, so a refused import cannot leave a half session behind.
- **All CDP work still runs through the one queue** with the 30 second clock and the caller's abort signal (spec 0001, spec 0004, rechecked here).
- **The session reaches disk when the CDP connection closes, not before.** The engine writes its cookie jar about 200 ms after the socket closes (measured: 211 ms), and a killed process writes nothing, so stopping closes the connection, settles, and only then kills the child. Stop faster and the session is silently lost.
- **The challenge limit is unchanged and stated**: an imported session is the route that works, and the engine's fingerprint is not claimed to pass a challenge on its own (measured, see rationale probe record).
- **The plugin never fetches cookies itself.** It reads a file the caller supplies; it does not reach into a real browser's profile, which keeps the trust boundary at the caller.

**Security model**: unchanged from spec 0004: single actor, the pi agent inside the pi process under the user's account, no roles, no tenants, no regulated data, and the same trust domain as shell tools. Three things change with this feature and each is handled above: the plugin now handles credentials (so values are never printed, and the profile is permission restricted), the profile is a durable secret on disk (so every report that names it says so), and an imported session is the caller's own credential, supplied deliberately rather than harvested (so the plugin reads only the file it is pointed at).

**Configuration required**:
- `profileDir` in `~/.pi/agent/obscura.json`: where the engine keeps the session jar. Defaults to `~/.pi/agent/obscura-profile`. Validated per key like every other setting, and passed to the engine as `--storage-dir`.

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: import a cookie file, see the names in the page, restart the engine, find the cookie still in the jar, then clear it and find it gone. Verifies **AC-1**, **AC-2**, **AC-3**.
- Secrecy: run every surface and grep the whole output for the cookie's value, which must appear nowhere. Verifies **AC-4**.
- Refusals: a missing file, malformed JSON, an unknown shape, an entry with no value, and an unknown action each refuse in plain words, and the jar is unchanged afterwards. Verifies **AC-5**.
- Configuration: a bad `profileDir` is refused with the setting named, and a good one takes effect at the next start. Verifies **AC-6**.
- The live case: import a real session's cookie for a challenged site and record what actually happened, whichever way it goes. Verifies **AC-7**.

## Build plan

Built against the real engine, per the project's Tracer Bullet approach: one thin end to end thread first (one cookie carried into a live page), then thicken. Every task names the AC it satisfies.

1. [ ] Profile directory end to end: the `profileDir` setting with its default and per key validation, passed to the engine as `--storage-dir`, and a self check case proving a cookie set in one process is in the jar of the next. Satisfies **AC-2**, **AC-6**.
2. [ ] Cookie core: set, list redacted, and clear over the `Network` and `Storage` methods the plugin already reaches, with the redaction rule enforced where the value would otherwise be read. Satisfies **AC-1**, **AC-3**, **AC-4**.
3. [ ] Import from an export file: accept the engine's own array shape and the wrapped `{ cookies: [...] }` shape, validate every entry before writing any, and refuse with the entry and the field named. Satisfies **AC-1**, **AC-5**.
4. [ ] Surfaces: the `browser_cookies` tool, the `/browser-cookies` command, and the profile line in the config view, all reporting the profile path with its plain text warning. Satisfies **AC-3**, **AC-5**, **AC-6**.
5. [ ] The live acceptance and the self check: attempt a challenged site with an imported session and record the outcome honestly, extend `scripts/` with a session self check covering the AC-8 cases, and write the probe record and the verify checklist. Satisfies **AC-7**, **AC-8**.

## Consequences

**Positive**:
- A site that refuses a browser with no history becomes reachable with a session the caller already has, which is the whole point of the feature.
- A session established once keeps working across runs, because the engine's own jar persists in the profile directory.
- The feature adds no dependency and no second protocol: the cookie methods were already answered on the connection the plugin holds, which the capability probe had simply never asked about.
- Session debugging stays safe by construction: the list is redacted, so an agent can look without leaking.

**Negative / tradeoffs**:
- The profile directory holds session cookies in plain text, so it is a credential store that the plugin now owns the care of. Its permissions and the never print rule are the only protection; full disk encryption is outside the plugin's reach.
- A cookie tool is a sharp surface: anything the agent can import, it can also clear, and a wrongly imported session can lock a site out until it is cleared.
- The engine's fingerprint is not improved by any of this, so a site that refuses the fingerprint refuses an imported session too. The feature widens which sites are reachable, it does not guarantee the challenged class.
- One more setting to explain, and one more thing that can be wrong (a path that cannot be created).

**Neutral**:
- The deferred items stay deferred: tabs, screenshots, PDF export, network and console capture live in the engine's MCP surface and are untouched here.
- The engine's capability probe under reports its own domains (it names four while `Network` and `Storage` answer), which is fixed as a follow-up rather than inside this feature.
- No change to any existing tool: cookie handling is additive.

## Follow-up

- [ ] The capability probe in `src/engine.ts` reports only Page, DOM, DOMSnapshot and Runtime while `Network` and `Storage` both answer (probe verified). Fix it so later features stop under rating the engine.
- [x] Confirm or override the three recommendations this spec makes on the engineer's behalf: the default profile directory (`~/.pi/agent/obscura-profile`), the two accepted export shapes, and that a cookie value is never printed even on request (a deliberate refusal, not a gap). All three confirmed on 2026-09-21. The engineer's own export turned out to be Netscape `cookies.txt`, which the confirmed shapes do not cover; accepting it is recorded as the next widening of AC-5.
- [ ] The engine's MCP surface (37 tools, including tabs, screenshots, PDF, network requests, console messages) remains unused. Revisit whether the plugin should speak it when one of those deferred features is picked up, with the measured costs in the rationale: a 152 line client, a different ref scheme, and a read shape that does not match the plugin's numbered refs.
- [ ] `/check verify session state` next; its checklist should include the live challenged site case, which depends on an external site staying as it is.
- [ ] A newer engine that closes the fingerprint gap would let the honest note in AC-7 be relaxed. Re visit then, not before.

## Rationale

Reasoning, the options weighed, and the probe record: see [rationale.md](rationale.md).
