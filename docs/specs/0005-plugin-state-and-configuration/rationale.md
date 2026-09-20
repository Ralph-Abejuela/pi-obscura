# Rationale: spec 0005 Plugin state and configuration

## Context

The plugin today hardcodes every setting it uses. `supervisor.ts` fixes the endpoint wait at 10 seconds, the spawn wrapper at 30 seconds, and the stop grace at 2 seconds, with a comment that feature 3 will turn them into config. `engine.ts` fixes the probe timeouts and the binary search order. `installer.ts` fixes the extract and version timeouts. The engine spawns with no explicit port, so it takes the shared default (9222), which is exactly the duplicate bind ambiguity spec 0003 recorded and verified. Stealth, which the engine supports and the scope names as a config item, is not used at all today.

Specs 0001 and 0003 each deferred a piece of this: 0001 says the connection settings (endpoint wait, port, binary path) are feature 3's decision, and 0003 lists two follow up items, the timeout constants and an explicit per session port, both riding on this feature. The scope's done when clauses name the goal: config (binary path, stealth, timeouts) reads from one source and applies at startup, state reconstructs after a hot reload, and errors reach you in plain words with a clear next step.

Two facts shape the design. Pi exposes no per extension settings API, so config has to be a file the plugin owns. And "state reconstructs after a hot reload" could be read as persistence, but spec 0003 already rebuilds the whole state machine on reload (AC-7 stops the engine, the next instance starts clean) and page state restoration was declined there; the feature's real job is to make config the single source and verify the rebuild, not to add a second file of runtime facts.

## Options considered

Each sub decision below lists the options the engineer weighed and which one was chosen. The chosen picks all carried the engineer's confirmation during the conversation.

### Config set: which values become configurable

1. All four: binary path override, stealth, timeouts, explicit port. Picks up both deferred follow ups in one schema. Was the choice.
2. Scope only: binary path, stealth, timeouts, leaving the port shared. Leaves the duplicate bind ambiguity in place.
3. Minimal: path and timeouts only. Least work today, but the scope names stealth and 0003 asks for the port.

### Config home: where the file lives

1. A JSON file beside the install at `~/.pi/agent/obscura.json`. Reuses the config dir the installer already writes to, survives reloads, works headless, no new machinery. Was the choice.
2. Environment variables: no types, no defaults, hard for the agent to inspect.
3. Per project config: browser settings are about the machine, not the repo.
4. pi's settings.json: couples the plugin to pi's schema, not a documented extension surface.

### Apply model: how changes take effect

1. Read at startup, re read at each engine start, plus a `/browser-config` command to view and edit. Values take effect at the next engine lifecycle moment, no reload needed. Was the choice.
2. Startup read only: every change needs a hand edit and a reload.
3. Live apply: a file watcher restarts the engine on change; real machinery for a settings file that changes rarely.

### Bad config: what a wrong value does

1. Per key fallback with a plain warning naming the key and the fix. The plugin stays alive, nothing is silent. Was the choice.
2. Fail the load: a typo takes the whole browser surface down.
3. Fail at spawn: the problem surfaces late, on first use.

### Reload semantics: what survives

1. Config only; the runtime machine rebuilds fresh, extending 0003 AC-7 with a re read. Nothing else persisted, matching the declined page state restoration. Was the choice.
2. Also persist lightweight facts (last binary path, last port): a second file and a write path for a lookup that is already cheap.

### Stealth depth: how far the integration goes

1. Config flag plus a capability check: one `obscura --help` run per binary path per session scans for `stealth`; a build without support spawns without the flag and warns plainly. Was the choice.
2. Flag only: pass it and let the engine's own output surface a missing build.
3. Installer picks a stealth asset: depends on such an asset existing in the official releases, which is not confirmed.

### Port strategy

1. Pick a free loopback port at each spawn, overridable with the `port` key. No collision, resolves the 0003 ambiguity. Was the choice.
2. A fixed config default: simplest, but reintroduces the exact leftover collision 0003 recorded.
3. `--port 0`, OS assigned: cleanest if the engine supports it, which is not confirmed; the free pick needs no engine support.

### Command writes

1. Validate before writing; the command refuses a wrong type or out of range value. Was the choice.
2. Write raw and let read time fallbacks catch it: a typo then needs a `/reload` to notice.

## Rationale

The thread through all seven picks is the same: the plugin stays boring, alive, and honest. Boring, because pi has no settings API and a JSON file is the least machinery that works, beside the install dir the plugin already owns. Alive, because a settings file is the one input a user will hand edit, and per key fallback means a typo degrades one value instead of taking the browser surface down. Honest, because the probe and the command report exactly which value is in force and which key fell back, and the stealth capability check turns an unverified engine flag (the default release asset's stealth support is not confirmed) into a plain fact instead of a silent pass.

The explicit free port is the load bearing change. Spec 0003 verified that leftover engines share the loopback bind and that the OS, not the plugin, then answers a CDP connection. Picking a free port each spawn removes the ambiguity without needing the engine to support `--port 0`. The config `port` key keeps a script or a firewall pin, at the cost of accepting that exact ambiguity back when pinned.

**Internal calls settled by the architect** (the engineer may override any of these):
- `binaryPath`: when set, checked first, then today's search order. Runner up, config only, was dropped because an override is an exception, not a replacement.
- Install and probe timeouts stay code constants. Runner up, promote all of them to config, was dropped because that path runs once and nobody tunes it.
- The bind address stays loopback and is not configurable, per the 0003 security model.
- The capability check caches per binary path per session, scans the `--help` output for `stealth`, and is bounded by a timeout; a failed run reads as not supported with the warning.
- `/browser-config set <key> ""` clears an override back to the default.
- The spawn error names the attempted port and binary path, so a wrong override or pinned port is diagnosable first try.