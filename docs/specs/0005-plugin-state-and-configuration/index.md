# 0005. Plugin state and configuration for the Obscura pi plugin

**Date**: 2026-09-21
**Status**: Accepted

## Summary

This feature gives the plugin one place for its settings: a small JSON file at `~/.pi/agent/obscura.json` that holds the binary path override, the stealth flag, the engine port, and the timeouts, re read at every engine start. A `/browser-config` command shows the effective values and edits the file with validation. A bad value falls back to its default with a plain warning, never a crash, and a hot reload re reads the file and rebuilds the runtime state fresh. Specs 0001 and 0003 deferred exactly these values to this feature.

## Requirements

**User stories**:
- As the agent, I want every browser call to use the same settings, so behavior is consistent and no value is guessed.
- As the user, I want to tune how the plugin starts the engine (binary path, stealth, port, timeouts) without editing code, so a change is a file edit or one command.
- As the user, I want a hot reload to come back working with the same settings, so nothing the plugin needs is lost when pi reloads.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):

- **AC-1**: Settings read from one source, the config file at `~/.pi/agent/obscura.json` when present, re read at every engine start, with defaults otherwise; the effective values (binary path override, stealth, port, connect timeout, spawn timeout, stop grace) apply when the engine starts. With no file present, the plugin behaves exactly as today's baked in values do.
- **AC-2**: The engine spawns with an explicit port: the plugin picks a free loopback port at spawn unless the config pins one. A leftover engine from an earlier session never blocks the spawn, and the plugin never kills a process it did not spawn (spec 0003 AC-6 holds).
- **AC-3**: When stealth is on, the plugin checks once per binary path per session that the installed binary accepts the `--stealth` flag. A binary without support still spawns, without the flag, and the probe and `/browser-config` say so in plain words with the next step.
- **AC-4**: A hot reload re reads the config and builds a fresh runtime state machine; nothing but the config file persists. This extends spec 0003 AC-7 (a reload stops the engine) with the re read.
- **AC-5**: A missing file, a corrupt file, a wrong value type, or an out of range value falls back per key to that key's default with a plain warning naming the key and the fix; unknown keys are ignored with a note; a bad config never crashes the plugin.
- **AC-6**: `/browser-config` shows the effective values with their source and the engine facts; its `set` form validates a value before writing and refuses a wrong type or out of range value with a plain message.

## Decision

**Chosen option**: Option 1, one JSON config file owned by the plugin at `~/.pi/agent/obscura.json`, re read at every engine start and at extension load, validated per key with defaults, edited through `/browser-config`; the spawn arguments (port, stealth) built from the effective values; a stealth capability check warns but never blocks.

**Implementation skills**: `obscura` (`h4ckf0r0day/obscura`, `.agents/skills/obscura/`) · `pi-extension-authoring` (`romiluz13/pi-agent-skills`, `.agents/skills/pi-extension-authoring/`)

## Feature design

**Data model**: one persisted entity, the config, as a JSON file. No relationships. Defaults apply when the file or a key is absent.

| field | type | default | effect |
|---|---|---|---|
| `binaryPath` | string or absent | absent | override; when set, checked first, then today's search order |
| `stealth` | boolean | false | passes `--stealth` on spawn when true, gated by the capability check |
| `port` | number or absent | absent | pins the spawn port; absent means a free port is picked at each spawn |
| `connectTimeoutMs` | number | 10000 | endpoint wait at spawn |
| `spawnTimeoutMs` | number | 30000 | spawn and CDP connect wrapper |
| `stopGraceMs` | number | 2000 | grace before hard kill at stop |

Rules: timeouts must be positive integers, port in 1 to 65535. A wrong type or out of range value falls back to that key's default with a plain warning naming the key. Unknown keys are ignored with a note. Install and probe timeouts (extract 60 s, version 10 s, per domain 5 s, probe total 30 s) stay code constants, since that path runs once and nobody tunes it.

**State transitions**: unchanged from spec 0003 (`stopped`, `starting`, `ready`, `dead`). Config only feeds inputs into a spawn (port, stealth, timeouts); no new state, nothing new persisted.

**API surface**: no new browser tools. The surface is the config module, the spawn path, and one command.

| Surface | What it does | Key inputs | Key outputs | Key errors |
|---|---|---|---|---|
| `config.ts` internal module | parse, validate, load, write | the file text | effective values plus warnings | none that escape; parse failures become per key fallback warnings |
| spawn path in the supervisor | build args from effective config | effective values | `serve --port <n>` plus `--stealth` when supported; timeouts | spawn error names the attempted port and binary path |
| `/browser-config` (view) | show effective values and engine facts | none | each key, its value, file or default, plus binary path, port, stealth support | none |
| `/browser-config set` | validate and write one key | key, value | the new effective value; an empty value clears an override | a wrong type, an unparseable value, or an out of range value refused with a plain message; a disk write failure refuses with a plain message and leaves the file unchanged |

`set` parses the value with the key's expected type (a number stays a number, `true` or `false` a boolean) and refuses a value that cannot parse. Setting a `binaryPath` that does not exist warns, it does not refuse. On a file that failed to parse, `set` rewrites it from the last successfully parsed keys plus the edit; the garbage drops, and the earlier warning already told the user. The capability check is one `obscura --help` run per binary path per session, bounded by a 5 second timeout, output scanned for `stealth`; a failed run reads as not supported. The view shows the verdict; with stealth off it shows not checked (stealth off) until the view runs the check on demand. Warnings are derived at each read and never persisted, so a fixed file clears them on the next probe or command. A changed value applies at the next engine start; the view says this plainly and there is no auto restart.

**Value sourcing** (every value each action produces, computes, or displays, and where it comes from):

| Action | Value produced / displayed | Source |
|---|---|---|
| Effective config in the probe and `/browser-config` | each key's effective value | the config file when the key is present, else the key's default |
| Engine spawn | the port | config `port` when set, else a free loopback port found at spawn |
| Engine spawn | the stealth flag | config `stealth`, gated by the capability check verdict |
| Capability check | whether the binary accepts `--stealth` | one `obscura --help` run per binary path per session, output scanned for `stealth`, bounded by a 5 second timeout |
| Stealth support in the view with stealth off | not checked (stealth off) until the view runs the check on demand | the effective `stealth` value and the check verdict |
| Probe and command warnings | which key fell back and why | `parseConfig` validation, one warning per offending key |
| Stop | the grace value | config `stopGraceMs`, default 2000 |
| Spawn error | the attempted port and path | the effective `port` (or the free pick) and the binary path used |

**Key invariants**:
- At most one engine process per extension instance (from 0003).
- The plugin never kills a process it did not spawn (from 0003).
- The config file is the only thing the plugin persists.
- Config warnings are derived at each read and never persisted.
- A failed stealth check caches as not supported for the session; a reload clears the cache.
- Read time fallback and write time validation both hold: the command never writes an invalid value, a hand edit still falls back per key.
- A spawn failure names the attempted port and binary path.

**Security model**: unchanged from 0003. The engine binds the loopback interface (127.0.0.1); the config file is a user owned file under the pi config dir; no credentials, no new trust boundary, no regulated data, no roles. The bind address stays loopback and is not configurable.

**Configuration required**: the config file itself as described above. No new environment variables or credentials.

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: a fresh machine with no config file; a browser call spawns on an explicit free port and works, defaults apply (no stealth, connect 10 s, spawn 30 s, grace 2 s). Verifies **AC-1**, **AC-2**.
- Config present: a file with `stealth: true`, `port: 9333`, custom timeouts, and a set `binaryPath`; the spawn uses all four, and the probe reports them. Verifies **AC-1**.
- Stealth missing: a binary without `--stealth` support with the flag on; the engine spawns without it, and the probe and `/browser-config` report it plainly. Verifies **AC-3**.
- Bad config: corrupt JSON or a wrong type (for example `stealth: "yes"`); per key fallback, the warning names the key, and the engine still works. Verifies **AC-5**.
- Command write: `/browser-config set port 99999` is refused with a plain message and the file is unchanged; on a corrupt file a `set` rewrites clean from the parsed keys plus the edit. Verifies **AC-6**.
- Reload: run a session, `/reload`, first browser call works and uses the current file. Verifies **AC-4**.
- Leftover engine: an old `obscura serve` keeps running on 9222; a new session picks a different free port, both run, the old process is untouched. Verifies **AC-2**.

## Build plan

Ordered for the Tracer Bullet approach: the thinnest end to end thread first (a real spawn with values from a config turned source), then each hardening pass.

1. Config module and first wiring: `config.ts` with the schema, defaults, per key validation, and `loadConfig`; the effective values threaded into the supervisor's spawn and timers at extension load. The explicit port lands already here. Satisfies **AC-1**, **AC-5**. [x] built
2. Explicit port: pick a free loopback port at spawn (bind `127.0.0.1:0`, close, reuse), `serve --port <n>` as the spawn line, the `port` key pins it, and a spawn error names the attempted port and binary path. Satisfies **AC-2**. [x] built
3. Stealth wiring: pass `--stealth` when configured; the capability check runs once per binary path per session (an `obscura --help` run with a timeout, output scanned for `stealth`); a binary without support spawns without the flag and a plain warning surfaces. Satisfies **AC-3**. [x] built
4. `/browser-config`: the view form prints effective values and engine facts; the set form validates before writing, refuses bad input, and reports the new effective values. Satisfies **AC-6**. [x] built
5. Reload and reporting: the probe and `/browser-config` show the config file path and any warnings; a `/reload` re reads the file and builds a fresh machine. Satisfies **AC-4**. [x] built
6. Verify pass: all critical scenarios run against the real plugin, including the leftover engine coexistence and the bad config fallbacks. Satisfies **AC-1**, **AC-2**, **AC-3**, **AC-4**, **AC-5**, **AC-6**. ([ ] this is the `/check verify` pass)

## Consequences

**Positive**:
- Settings live in one file; you and the agent read the same values the engine runs with.
- A change to port, stealth, or a timeout is a file edit or one command, and takes effect at the next engine lifecycle moment; no reload needed.
- The explicit free port removes the duplicate bind ambiguity spec 0003 recorded; a leftover engine and the session engine coexist on different ports.
- A bad config cannot take the plugin down; it falls back with a warning that names the key and the fix.

**Negative / tradeoffs**:
- A wrong `binaryPath` override points the plugin at a broken binary; the spawn error names the path and how to clear the key.
- Stealth is only as good as the installed build; the capability check adds one small help run per binary per session, and a stealth-less build cannot get stealth without a different install.
- A hand edited file with a typo silently runs that key's default until a probe or `/browser-config` reports it; the warning does not interrupt a call.
- The free port pick has a tiny race between finding the port and the engine binding it; nothing else binds loopback ports in practice, so this is negligible.

**Neutral**:
- The spawn line changes shape: `serve --port <n>` instead of the engine's default port. The endpoint is still read from the printed line, so nothing downstream changes.
- Install and probe timeouts stay code constants until someone tunes them.

## Follow-up

- [ ] The stealth capability check proves live whether the default release asset includes stealth. If it does not, consider enrolling an installer follow up to fetch a stealth enabled variant asset when stealth is on.
- [ ] The install and probe timeouts remain code constants; promote them to config keys if they are ever tuned.

## Rationale

Reasoning and options: see [rationale.md](rationale.md).