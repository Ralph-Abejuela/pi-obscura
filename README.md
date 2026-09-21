# pi obscura

> ## Abandoned
>
> **This project is abandoned and unmaintained.** It was built to give pi a real browser, and on
> ordinary sites it does exactly that. What stopped it is the engine underneath: it cannot get past
> active bot management, which is the difference between something that demos well and something an
> agent can rely on. The code is left exactly as it stands, with no license, no support, and no
> promise that any of it still works against a current engine release. Nothing here will be fixed,
> updated, or answered. What follows is why it exists and the honest record of why it stopped.

## Why this exists

pi could read files and run shell commands, and that is nearly enough to work on a computer. It is
not enough to use the web the way a person does. An agent that cannot open a page, read it, click a
button, fill a form, and wait for the result is blind to most of the world's actual interfaces, and
the interesting problems usually live behind those interfaces rather than in an API.

The bet was that a small Rust headless browser could close that gap cheaply. Obscura runs real
JavaScript through V8, speaks the Chrome DevTools Protocol, and is a fraction of Chromium's weight,
so a pi extension could own an engine process and expose a real browser through pi's own tools
without dragging a second browser into the machine. That is what this repository does.

The whole surface, once built:

- **16 tools**: `browser_probe`, `browser_navigate`, `browser_read`, `browser_back`,
  `browser_forward`, `browser_reload`, `browser_click`, `browser_fill`, `browser_type`,
  `browser_choose`, `browser_scroll`, `browser_key`, `browser_eval`, `browser_wait`,
  `browser_cookies`, `browser_install`.
- **4 commands**: `/browser-status`, `/browser-config`, `/browser-cookies`, `/browser-install`.
- **One supervised engine per session**: started on first use, watched for death, restarted by the
  next call, stopped cleanly on reload or shutdown, and never killing a process it did not spawn.
- **One queue, one clock**: every browser operation runs serially through a single queue with a 30
  second bound and the caller's abort signal, the same discipline the shell tools use.
- **Failures in plain words**: every error is mapped to one of four categories (engine down, page
  error, protocol unsupported, timeout) with a next step attached.

## What works

Verified while the project was alive, by five self checks plus the verify checklist beside each
spec, rather than by hope:

| Area | State |
| --- | --- |
| Navigation, history, reload | works |
| Reading a page as markdown with numbered element references | works |
| Click, fill, type, choose, scroll, key, with references refreshed after every action | works |
| Running your own JavaScript in the page, awaiting promises, and polling until content appears | works |
| Cookies: import an export, list redacted, clear, and keep a session in a profile directory across runs | works |
| Bootstrapping: finding, installing, and verifying the engine binary | works |
| An active bot challenge | **fails, and this is why the project is abandoned** |

## What does not work, and how that was measured

The engine was tested against a Cloudflare managed challenge, which is what a great many of the
sites an agent most wants to reach sit behind. It failed in every configuration:

- plain mode and stealth mode (`--stealth`), both on the plugin's CDP connection;
- the engine's own MCP surface, which is a different transport entirely;
- and with a **real session**: a 14 cookie export from an incognito browser that had passed the
  challenge, including `cf_clearance` and `__cf_bm`, was imported through `browser_cookies`,
  carried into the engine, and Cloudflare still served the interstitial with zero results.

The causes were measured rather than guessed, and they are properties of the engine, not of this
plugin:

- **No WebGL at all** (`getContext("webgl")` returns null) while the engine claims `Chrome/143`. A
  Chrome that cannot do WebGL is the loudest signal a challenge looks for.
- **A TLS hello with no GREASE values**, in both modes. The stealth flag reorders ciphers and
  extensions; it does not make the connection look like Chrome's.
- **Fingerprint values randomized per process** (`hardwareConcurrency`, `deviceMemory`, `screen`, a
  canvas hash). Consistent within a session, which is the sane design, but a persona rather than a
  real browser.

A valid `cf_clearance` cookie did not help because Cloudflare binds it to the connection that earned
it. The plugin carried the session exactly as designed, so this is a ceiling on the engine.

## Why it stopped

The reason to build this was "an agent that can browse the real web". Bot management is not an edge
case on the web an agent wants: job boards, most SaaS, news, and commerce all use it, and the
engine's fingerprint fails it. Nothing inside this plugin can fix that. The honest options were a
real Chrome (a different product, contradicting the entire reason the engine was chosen) or the
engine's own hosted service with residential proxies (someone else's product to buy). Neither is a
bug fix, so the project stops here rather than half promising something it cannot deliver.

One more angle worth reading before anyone revives this: the site's own `robots.txt` disallowed any
URL carrying a query string, its search API, and its GraphQL endpoint, so even a working engine
would have been outside what that site permits for anything past the first page. Some of what looks
like a technical limit is a policy limit, and it would have bound this project regardless.

## What is still worth keeping

- **The code as a working reference**: about 4,200 lines of TypeScript of a pi extension that drives
  CDP, plus about 1,100 lines of self checks. The engine lifecycle, the single queue, the one clock,
  the plain error mapper, the markdown and reference serializer, and the session storage are all
  written and all verified, and none of them are Obscura specific.
- **The probe records**: eight specs in `docs/specs/` record what this engine actually does, each
  with a `rationale.md` naming the throwaway probe that measured it. The odd-shaped page errors
  (`Runtime.callFunctionOn` raises `JS error: <message>` instead of exception details), the 30
  second await bound, `innerText` equalling `textContent`, the cookie jar flushing only when the CDP
  socket closes, and the engine's MCP surface being far wider than its CDP surface are all written
  down with evidence.
- **The session work**: `browser_cookies` plus a profile directory gives a persistent, importable
  session, and that is orthogonal to the challenge problem. It is useful to any browser automation
  that has a better engine behind it.

## Running it

```bash
npm install
npm run typecheck
npm run lint

# the self checks, each against the real engine and data: URLs
node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs scripts/config-selfcheck.ts
node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs scripts/navigation-selfcheck.ts
node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs scripts/interaction-selfcheck.ts
node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs scripts/script-selfcheck.ts
node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs scripts/session-selfcheck.ts

# or load the extension into pi
pi -e ./src/index.ts
```

The engine binary is not in this repository. The plugin finds it, offers to install it for your
platform, and verifies it runs before using it. The engine refuses loopback and private addresses,
which is why every fixture in the self checks is a `data:` URL.

## Where the reasoning lives

- `docs/scope/scope.md`: the plan, the features, and what shipped.
- `docs/specs/0001` to `docs/specs/0008`: one decision each, with the probe record beside it.
- `docs/reviews/2026-09-21-feat-script-and-wait.md`: the code review that caught two real defects
  before the last feature merged.
- `AGENTS.md`: the conventions the code follows.

## Credit

The engine is [Obscura](https://github.com/h4ckf0r0day/obscura), a Rust headless browser by
h4ckf0r0day, used under its own Apache 2.0 license. This plugin only drives it over CDP. This
repository itself carries no license file, so assume no rights are granted: abandonware, offered
only as reading material. It was never published as a package either (`package.json` is private), so
there is no installable artifact to depend on.
