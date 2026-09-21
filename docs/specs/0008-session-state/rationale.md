# 0008 rationale. Session state: a saved profile and imported cookies

## Context

The plugin exists to let the agent browse real pages. A live test through its own tools ended at a Cloudflare managed challenge on a real job board, and the engine never got past it: plain mode, stealth mode, the plugin's CDP path, and the engine's own MCP surface all landed on the same interstitial, with zero job cards read. The host itself is reachable from the plugin (`robots.txt` fetched fine), so this is the route's bot rules answering, not a broken connection.

The engine's stealth is real but bounded. Measured on this machine: `--stealth` changes the TLS hello (a different JA3 hash, the same order normalized `ja3n` hash) and masks the obvious flags, but the hello carries no GREASE values, `getContext("webgl")` returns null so the engine exposes no WebGL at all while claiming `Chrome/143`, and `hardwareConcurrency`, `deviceMemory`, `screen` and a canvas hash are randomized per process. Those are exactly the surfaces a managed challenge scores, and the project's own issue tracker shows the same class of failure on Cloudflare protected sites.

The route that works on any engine is a session the site already trusts: a cookie earned by a browser that passed the challenge. The plugin had no way to carry one, and nothing it did survived a restart, so this decision is about the smallest honest way to get both.

The decision looked expensive because the plugin's capability probe reports only four CDP domains (`Page`, `DOM`, `DOMSnapshot`, `Runtime`). It does not ask about cookies, and it turns out they answer.

## Options considered

### Option 1: keep the CDP connection, add cookie tools, and use the engine's profile directory

Set, list, and clear cookies over the `Network` and `Storage` CDP methods the plugin already reaches, and pass `--storage-dir` so the engine's own jar survives between runs.

**Pros**:
- Measured to work on the connection the plugin already holds, so no new transport, dependency, or protocol.
- The plugin keeps its read model and numeric refs, which the MCP does not reproduce.
- The profile half is free: the engine already persists the jar, so the plugin stores nothing itself and has no second source of truth.

**Cons**:
- The profile file holds cookies in plain text, so the plugin now owns a credential store's care.
- Nothing here improves the fingerprint, so a site that refuses the engine still refuses an imported session.

### Option 2: speak the engine's MCP, where cookies and storage state already exist

Spawn `obscura mcp` and drive the page through its 37 tools instead of raw CDP.

**Pros**:
- Cookies, storage state, tabs, screenshots, PDF, network requests and console messages all exist there already.
- Would retire a large part of the plugin's hand written CDP layer.

**Cons**:
- A measured 152 line client for the handshake and calls, plus its own lifecycle besides the supervisor's.
- A different ref scheme (`ref=e1` strings against the plugin's numbers) and a read shape that does not match: the MCP's markdown is not cross linked to its element list, so the agent would need two calls and lose the `[1] → node 17` linking the read tool prints today.
- Pays that cost for capabilities this feature can get from CDP in a few lines.

### Option 3: the plugin owns the cookie store

Read the jar over CDP and write the plugin's own file, restoring it at start.

**Pros**:
- Full control of the format, and it would work even without the engine's profile flag.

**Cons**:
- Duplicates what the engine already does correctly (measured: `--storage-dir` persists), and creates a second source of truth that can drift from the live jar.
- More code, more secret handling, and a restore path that can silently diverge from the engine's own expiry and domain rules.

### Option 4: attach to a real Chrome instead of the engine

**Pros**:
- The only option that actually passes challenge grade bot management.

**Cons**:
- It is a different product, contradicting spec 0001's decision to run the engine rather than Chrome, and it would need a new stack decision rather than a feature.

## Rationale

Option 1 wins on measurement rather than taste. The cookie methods answer on the connection the plugin already holds (`Network.setCookie` returned `{"success":true}` and the page saw the cookie), and the profile flag persists the jar across processes, so the two halves of the feature cost a setting and a tool rather than a transport. Option 2's costs are real and were measured, not guessed: 152 lines of client, a foreign ref scheme, and a read output shape the plugin would have to regress or reimplement. Its extra surfaces are genuine, but they belong to the deferred items (tabs, screenshots, PDF, diagnostics) rather than to session state, so the transport question stays open for whoever picks one of those up.

Option 3 was rejected because the engine already persists the jar, and a second store would be a drift risk for no gain. Option 4 is recorded because it is the honest answer to the stronger requirement: if passing bot management itself becomes the goal, the plugin cannot get there by improving its use of this engine, and that is a stack decision, not a feature.

The security posture follows from one measured fact: the profile's `cookies.json` is plain readable JSON, values included. So the plugin's obligations are the ones the acceptance criteria name: never print a value, create the directory owner only, and say plainly that session cookies live there unencrypted. No obfuscation is proposed, because a local file readable by the user's own account gains little from it.

## Probe record

Throwaway scripts in the gitignored `scratch/`, run on 2026-09-21 against obscura 0.2.2 (`~/.pi/agent/bin/obscura.exe`).

```bash
node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs scratch/mcp-probe.ts
node .../jiti-cli.mjs scratch/cdp-cookie-probe.ts
node .../jiti-cli.mjs scratch/storage-dir-probe.ts
```

**The engine's MCP surface is wider than its CDP probe suggests.** `obscura mcp` answers `initialize` as `obscura-mcp 0.2.2` and lists **37 tools**, including cookies, storage state, tabs, screenshots, PDF, network requests and console messages. 19 of them are page or session operations. A minimal client for the handshake and `tools/call` is **152 lines**. Its read model differs from the plugin's: `browser_markdown` returned plain markdown with no numbering (65 characters for the fixture), `browser_interactive_elements` returned `ref=e1  a  "alpha link"` rows (string refs), and a `browser_click` given a numeric ref failed with "Missing 'ref' or 'selector' parameter". Its cookie round trip worked: `browser_set_cookie` set one, the jar listed it, `document.cookie` showed `pi_probe=from-mcp`, and `browser_storage_state` exported it (358 characters).

**The plugin's own CDP connection answers cookie calls**, which its capability probe had never asked about:

| Call | Result |
| --- | --- |
| `Network.setCookie` | `{"success":true}` in 1 ms |
| `Network.getCookies` / `Network.getAllCookies` | the jar, with the cookie set |
| `Storage.getCookies` | the same jar |
| `Storage.setCookies` | accepted (`{}`) |
| `Runtime.evaluate` `document.cookie` | `pi_cdp=from-cdp; pi_cdp2=v2` |

**The engine's profile directory persists a cookie across processes.** Process 1 set `pi_persist` over CDP and reported a jar of 1 cookie; a second engine process on the same `--storage-dir` reported `["pi_persist=written-by-cdp"]`. The directory contains `cookies.json`, a plain JSON array holding name, value, domain, path, secure, httpOnly, sameSite and expires in clear text.

**A first version of that persistence check was wrong, and the mistake is worth recording.** An earlier attempt set the cookie from page script through the CLI's `--eval` and read `document.cookie` in a second run; it printed `null` for a statement list and left `cookies.json` empty, which said nothing about persistence and could easily have been read as "persistence does not work". The corrected check sets the cookie over CDP, where the mechanism is proven, and reads the jar from a second process. A separate check in this session reported a false pass in 8 ms for the same class of reason: it never navigated, so its condition was trivially true on `about:blank`. Both are recorded because the next person will write one of them.

**The live limit, measured through every surface.** Fetching the challenged listing produced `Just a moment...` and 0 job cards via the plugin's tools (plain), through the plugin's stealth spawn line (`obscura serve --port 22270 --stealth`), and through the engine's MCP tools. Cloudflare's own `__cf_bm` cookie appeared in the jar while no `cf_clearance` was ever issued, so the engine is being scored and refused rather than failing to connect. `robots.txt` on the same host fetched successfully through the same engine, and it disallows any URL with a query string, `/api/jobsearch/` and `/graphql`, so pagination and the site's own search API are outside what that site permits regardless of the challenge.
