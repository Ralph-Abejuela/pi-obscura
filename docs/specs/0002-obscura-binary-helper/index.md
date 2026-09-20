# 0002. Obscura binary helper

**Date**: 2026-09-20
**Status**: Accepted

## Summary

The plugin is useless without the Obscura engine binary, and today a missing binary is a dead end. This spec decides how the plugin offers to install the engine, downloads the right official build for your operating system straight from the Obscura GitHub releases, unpacks it into one known user folder, proves it runs, and then reports the engine's protocol coverage right away. The installer uses only what Node and your operating system already provide, so the package gains no new dependencies.

## Requirements

**User stories**:
- As an engineer, I want a missing engine to come with a clear way out, so the first run is not a dead end.
- As an engineer, I want the install to fetch the official build for my OS without me hunting for asset names, so setup takes one command.
- As the agent, I want to offer and perform the install myself, so a browsing task can recover from a missing engine.
- As an engineer, I want to be asked before any executable is downloaded on my behalf, so nothing lands on my machine silently.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):
- **AC-1**: With no binary installed, the engine probe result names the way out in plain words: run `/browser-install`, or have the agent call `browser_install`.
- **AC-2**: An install maps the current OS and architecture to an asset filename by the selection table in this spec (Windows x86_64 zip, macOS and Linux tar.gz, x86_64 and aarch64), always the default render variant, and downloads it from `releases/latest/download/<asset>`, the URL that GitHub redirects to the newest release. A platform with no asset fails before any network call (AC-9).
- **AC-3**: The bytes written must equal the download response's own `Content-Length`. On any mismatch the install fails with a plain message, nothing is placed in the destination, and temp files are removed.
- **AC-4**: The archive is extracted with the operating system's own tar tool into a same volume temp folder inside the destination, the extracted tree is searched for the obscura binary (any internal layout), and the binary lands at `~/.pi/agent/bin/obscura.exe` on Windows or `~/.pi/agent/bin/obscura` otherwise. The folder is created if missing.
- **AC-5**: After extraction the binary must run with `--version`, exit 0, and print text containing a version style number (`\d+\.\d+`). If it cannot run or spawn, the message follows the per OS wording in the message catalog (antivirus on Windows, Gatekeeper quarantine on macOS, noexec mount on Linux) and gives a next step. The underlying failure was observed live during feature 1's verification.
- **AC-6**: Consent split: the `browser_install` tool always asks through pi's own confirm prompt before downloading, and a decline aborts with nothing downloaded. The `/browser-install` command does not ask before downloading, because typing it is the yes. The overwrite ask of AC-7 applies on both surfaces.
- **AC-7**: When a binary already exists at the destination, install reports its path and version and asks before overwriting, on both surfaces. If the existing binary cannot report a version, that is said plainly and the overwrite doubles as the repair.
- **AC-8**: After a successful install the engine probe (spec 0001's capability probe) runs automatically and the reply includes the CDP domain coverage report for Page, DOM, DOMSnapshot, and Runtime. If the probe fails, the install still counts as successful and the reply carries the probe's plain error as a warning.
- **AC-9**: A platform or architecture with no matching asset (for example Windows on ARM) fails before any download with a plain message naming the platform and listing the available targets.

## Decision

**Chosen option**: A self installer inside the plugin: map the platform to an asset by table, download from `releases/latest/download/<asset>` with Node's built in fetch, check the byte count against the response's `Content-Length`, extract with the operating system's tar binary, verify by running `--version`, all into `~/.pi/agent/bin`. No GitHub API calls, no new dependencies.

**Implementation skills**: `obscura` (`h4ckf0r0day/obscura`, `.agents/skills/obscura/`) · `pi-extension-authoring` (`romiluz13/pi-agent-skills`, `.agents/skills/pi-extension-authoring/`)

## Feature design

**Data model sketch**:
None. There is no database and no persisted metadata. The binary on disk is the state, and the installed version is read on demand from `--version`. The destination is one constant until feature 3 (plugin state and configuration) owns path configuration.

**State transitions** (install flow, one run at a time, serialized through the extension's operation queue per spec 0001, the queue held for the whole flow including prompts):

```text
idle → mapping → downloading → extracting → verifying → probing → done
                          ↳ any step fails → failed (plain message from the catalog, temp cleaned)
mapping → unsupported (no asset for this platform, nothing sent over the network)
downloading → declined (consent refused, nothing downloaded)
```

**API surface**:

| Surface | Trigger | Key inputs | Key outputs | Consent | Key errors |
|---|---|---|---|---|---|
| `browser_install` (tool) | agent call | none | plain report: installed version, asset name, destination path, verify result, coverage report | confirm before download, confirm again before overwrite | declined, unsupported platform, size mismatch, extraction failed, verify failed, network |
| `/browser-install` (command) | user types it | none | same report through notify and the status line | none before download (typing it is consent), asks before overwrite | same as the tool |

**Asset selection table** (how AC-2 resolves the filename; variant is fixed to the default render build by this spec):

| Platform (process.platform) | Architecture (process.arch) | Asset | Format |
|---|---|---|---|
| win32 | x64 | `obscura-x86_64-windows.zip` | zip |
| darwin | x64 | `obscura-x86_64-macos.tar.gz` | tar.gz |
| darwin | arm64 | `obscura-aarch64-macos.tar.gz` | tar.gz |
| linux | x64 | `obscura-x86_64-linux.tar.gz` | tar.gz |
| linux | arm64 | `obscura-aarch64-linux.tar.gz` | tar.gz |
| anything else | | no download, plain message | |

**Message catalog** (every user facing install message, plain words, the contract for AC-1 and AC-5 wording):

| Situation | Message content |
|---|---|
| Missing binary (probe result, AC-1) | The engine is not installed. Run `/browser-install`, or ask the agent to call `browser_install`. |
| Unsupported platform (AC-9) | No Obscura release exists for `<platform> <arch>`. Available targets: Windows x64, macOS x64 and arm64, Linux x64 and arm64. |
| Download failed | The download failed (`<reason>`). Check the connection and run the install again. On a proxied network, Node 24 may need `NODE_USE_ENV_PROXY=1`. |
| Size mismatch (AC-3) | The download was incomplete (`<written>` of `<expected>` bytes). Nothing was installed; run the install again. |
| Extraction failed | The archive could not be extracted (`<reason>`). Nothing was installed. |
| Verify failed, Windows (AC-5) | The engine was installed but would not run. Your antivirus may have blocked it; add an exception for the binary or run it once by hand, then run `/browser-status`. |
| Verify failed, macOS (AC-5) | The engine was installed but macOS blocked it (Gatekeeper quarantine). Clear the quarantine flag on the binary or approve it in System Settings, then run `/browser-status`. |
| Verify failed, Linux (AC-5) | The engine was installed but would not run. The filesystem may be mounted noexec; move the binary somewhere executable, then run `/browser-status`. |
| Existing binary (AC-7) | An engine already exists at `<path>` (version `<v>`, or no version reported). Overwrite it with the latest release? |
| Declined | Install cancelled; nothing was downloaded or changed. |
| Probe failed after install (AC-8) | The engine is installed and verified, but the coverage check failed (`<reason>`). Browsing may still work; run `/browser-status` to retry. |

**Value sourcing** (every value an install produces or displays, and where it comes from):

| Action | Value produced / displayed | Source |
|---|---|---|
| install | asset filename | derived from `process.platform`, `process.arch`, and the variant decision (selection table) |
| install | download URL | the `releases/latest/download/<asset>` pattern, decided in this spec |
| install | expected byte size | the download response's `Content-Length` header |
| install | progress percent | bytes written against `Content-Length` |
| install | destination path | constant `~/.pi/agent/bin`, decided in this spec (feature 3 may own it later) |
| install | archive format | derived from OS: zip on Windows, tar.gz otherwise |
| install | installed version and release tag | the binary's `--version` output |
| install | coverage report | `probeEngine` in `src/engine.ts` (spec 0001's capability probe) |
| install, probe | existing binary path | `findBinary` in `src/engine.ts`, extended with `~/.pi/agent/bin` first in the search order |

**Key invariants**:
- No binary is ever placed in the destination unless the size check passed and the verify run passed.
- All temp work happens in a `.tmp-` subfolder inside `~/.pi/agent/bin` (same volume, so the final move is a rename, never a cross volume copy) and is removed on every path, success or failure.
- Every spawned child (tar, `--version`) runs under a timeout (60 seconds for extraction, 10 seconds for the version run), honors the abort signal, and is killed on timeout, so a hung child can never wedge the operation queue.
- Downloads happen only over HTTPS from `github.com/h4ckf0r0day/obscura`. No mirrors.
- Installs never run concurrently with other browser operations; the queue is held across the whole flow, prompts included.

**Security model**:
The only trust decision is downloading and running an executable from the official Obscura GitHub releases. The consent split makes that decision explicit for both surfaces. Integrity rests on the HTTPS transport, the byte count check against the response's `Content-Length`, and the verify run, because upstream publishes no checksum files. The size check catches truncated and corrupted transfers; it cannot detect a substituted artifact on the transport itself, an accepted residue documented in Consequences. The installed binary runs with the user's own privileges, the same trust level as any tool the user installs manually.

**Configuration required**:
None. No environment variables or credentials. On a proxied network the standard `NODE_USE_ENV_PROXY=1` (a Node 24 feature) applies to the download; it is user environment, not plugin configuration. Feature 3 may later add a binary path override; this spec fixes only the default.

**Critical test scenarios** (each maps to an acceptance criterion in ## Requirements):
- Happy path: on this Windows x64 machine, `/browser-install` downloads `obscura-x86_64-windows.zip` from the latest release, bytes match `Content-Length`, tar extracts it, `--version` prints a version, and the reply ends with the domain coverage report, verifies **AC-2, AC-3, AC-4, AC-5, AC-8**
- Failure case: the verify run fails or the spawn is blocked, the message follows the Windows wording in the catalog with a next step, and no partial binary remains, verifies **AC-5, AC-3**
- Timeout case: a hung tar or version child is killed at its timeout and the queue stays usable for later operations, verifies **AC-4, AC-5**
- Consent: the agent calls `browser_install`, the user declines the confirm, nothing is downloaded and the reply says so, verifies **AC-6**
- Existing install: with a binary present, install reports its path and version and asks before overwriting, on both surfaces, verifies **AC-7**

## Build plan

Tracer Bullet order: stand up the whole thin thread (map, download, extract, verify) behind the command first so it is real end to end, then add the tool and consent layer, then the probe integration.

1. Asset mapping: map platform and architecture to the asset filename by the selection table, fail plainly before any network call when nothing matches, satisfies **AC-2**, **AC-9**
2. Downloader: stream the asset with Node's built in fetch from `releases/latest/download/<asset>` to a temp file, report progress percent, compare bytes written against `Content-Length`, clean up on failure, satisfies **AC-3**
3. Extractor: spawn the platform tar (`tar -xf`, 60 second timeout) into a same volume `.tmp-` folder, walk the extracted tree to find the obscura binary, rename it into `~/.pi/agent/bin`, satisfies **AC-4**
4. Verify run: spawn the installed binary with `--version` (10 second timeout), require exit 0 and a version style number, per OS failure messages from the catalog, satisfies **AC-5**
5. Surfaces: `/browser-install` command and `browser_install` tool, consent split with the overwrite ask on both surfaces, existing binary report, and the probe's missing binary message updated to name the command and the tool, satisfies **AC-1**, **AC-6**, **AC-7**
6. Auto probe: after a successful install run `probeEngine`, include the coverage report in the reply, report a probe failure as a warning per the catalog, satisfies **AC-8**

## Consequences

**Positive**:
- The first run is never a dead end: missing engine leads to a one step, consented install that ends with proof the engine works.
- Zero new npm dependencies; the installer rides on Node's fetch and the operating system's tar, and needs no GitHub API calls at all.
- One known install location that survives plugin updates and reinstalls, easy to find and delete.
- Every install ends with the engine's real protocol coverage, so feature 1's pending CDP coverage check closes itself on the first install.

**Negative / tradeoffs**:
- The download is large (about 72 MB on Windows), so the install is not instant and reports progress.
- Upstream publishes no checksum files, so integrity rests on the size check, the verify run, and explicit consent. The size check compares against the same server's own header, so it catches truncated transfers but not a substituted artifact; that residue is accepted until upstream publishes checksums.
- The installer depends on the OS tar binary (Windows 10 1803 and later ship one); without it the install fails plainly.
- There is no update check; reinstalling is the update path.
- The queue is held while the user answers a confirm prompt, so browser operations wait behind an unanswered prompt; acceptable because installs are rare and explicit.

## Follow-up

- [ ] Feature 3 (plugin state and configuration) should take ownership of the binary path constant and any user override; this spec fixes the default only.
- [ ] `findBinary` gains `~/.pi/agent/bin` as the first search location in this build; the canonical search list belongs to feature 3.
- [ ] If upstream starts publishing checksum files, switch the integrity check from `Content-Length` to SHA256.
- [ ] The `obscura` and `pi-extension-authoring` skills are still not recorded in root `AGENTS.md` (carried from spec 0001); `/audit` should capture them.
- [ ] Consider an update check surface later if stale engines become a real problem.

## Rationale

Reasoning, options, and the verified release inventory: see [rationale.md](rationale.md).
