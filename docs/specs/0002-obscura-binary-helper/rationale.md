# 0002 · Obscura binary helper · rationale

## Context

The plugin manages an Obscura process for the agent, but the engine binary is not something pi ships. Until it exists on the machine, every browser tool is a dead end, and the probe built in feature 1 can only report the absence in plain words. The scope row for this feature asks for exactly the missing half: when the engine is missing, tell you plainly and get it installed, so the first run is not a dead end.

The forces that shaped this decision:

- **One official distribution channel.** Obscura publishes release archives on GitHub (`h4ckf0r0day/obscura`). The crate name on crates.io belongs to an unrelated 2019 raytracing library, so `cargo install obscura` would install the wrong software entirely. Any installer must therefore use GitHub releases and nothing else.
- **A real asset matrix, verified live.** Since v0.2.0 every platform ships four build variants (default with rendering, `-stealth`, and two `-no-render` variants). The v0.2.2 inventory (below) confirms the exact naming scheme, that Windows is zip while macOS and Linux are tar.gz, and that no checksum files are published at all.
- **Consent matters.** This installer downloads and runs an executable. The engineer chose offer then install on yes: the plugin may offer, but the download only happens after an explicit yes, and the two surfaces (tool for the agent, command for the human) need a clean consent split.
- **The stack is deliberately thin.** Spec 0001 chose a thin client with no build step. Pulling in an archive extraction library for one download would work against that spirit when the operating system already ships a tool that handles both archive formats.

## Options considered

### Option 1: Self installer inside the plugin (chosen)

The extension maps the platform to an asset filename by table, downloads it from the `releases/latest/download/<asset>` URL with Node's built in fetch, checks the byte count against the response's `Content-Length`, extracts with the platform's tar binary, and verifies the binary by running `--version`, all into `~/.pi/agent/bin`.

**Pros**:
- One step from missing engine to working, probed engine, exactly what the scope asks for.
- Zero new npm dependencies and zero API calls; fetch is built in, the `releases/latest/download` URL needs no tag resolution, and tar ships with Windows 10 1803+, macOS, and Linux.
- The install ends with the engine's real protocol coverage, closing feature 1's pending coverage check automatically.

**Cons**:
- The plugin now owns download, extraction, and verification code, including its failure modes.
- Large downloads (about 72 MB on Windows) need progress feedback and tolerate slow networks.
- Without upstream checksums, integrity rests on the size check, the verify run, and consent.

### Option 2: Manual instructions only

The probe keeps telling the user plainly to download a release from GitHub and where to put it. No install code at all.

**Pros**:
- Zero risk, zero code; the plugin never touches downloads.

**Cons**:
- The first run stays a dead end for anyone who does not want to hand place binaries; the agent cannot recover on its own.
- The asset naming scheme (arch, OS, four variants) is easy to get wrong by hand.

### Option 3: cargo install

Install through Rust's package manager.

**Pros**:
- A single familiar command, on PATH afterwards.

**Cons**:
- The crates.io crate named `obscura` is an unrelated raytracing library (verified), so this path installs the wrong software.
- Requires a Rust toolchain on the user's machine.

### Option 4: npm platform packages

Publish or rely on npm wrapper packages (one per platform, installed as optional dependencies), the way some Node tools ship native binaries.

**Pros**:
- Installs ride npm's existing machinery; pi already installs npm dependencies.

**Cons**:
- No such wrapper packages exist upstream, so this means publishing and maintaining five packages per release, far outside this plugin's scope.

## Rationale

The self installer is the only option that delivers the scope's promise (first run not a dead end) without new dependencies or new infrastructure. The design leans on two boring, proven pieces: Node's fetch for the download and the operating system's tar for extraction, so the failure modes are the familiar ones (network, disk, permissions) rather than library surprises.

`~/.pi/agent/bin` as the destination keeps the binary out of the plugin's own folder (which npm wipes on reinstall), gives one known location for cleanup, and gives `findBinary` a single extra place to look. Always latest with overwrite on reinstall keeps the state model empty: the binary on disk is the only state, the version comes from `--version` on demand, and feature 3 can later own path configuration without this spec having invented a config format early.

The consent split puts the security decision where the intent lives: an agent initiated install always asks through pi's own prompt, a human typed command is its own yes for the download, and the overwrite ask applies on both surfaces because replacing an existing binary is a distinct destructive act. Because upstream publishes no checksums, comparing bytes written against the response's own `Content-Length` is the honest middle ground: it catches truncated or corrupted downloads without pretending to be cryptographic verification, and the verify run plus the auto probe catch a binary that downloads fine but cannot run, which we observed live (a copied executable was refused with EACCES during feature 1's verification, almost certainly antivirus policy).

## References

**Project sources** (verifiable, in this repo):
- Spec 0001 (stack and connection architecture): the thin client spirit, the one queue contract, the capability probe this install ends with
- The `obscura` skill (`.agents/skills/obscura/`): build variants, the `--stealth` flag's build requirement, official release archives include rendering
- `docs/scope/scope.md` feature 4: the intent and Done when this spec implements

**Practices & standards**:
- Native platform features before dependencies (tar ships with the OS)
- Explicit consent before downloading and running executables
- Verify by running, not by file presence (the version run proves the binary works)

**Links** (web verified only, fetched 2026-09-20):
- Obscura releases page: https://github.com/h4ckf0r0day/obscura/releases
- v0.2.2 release notes (variant table, self reported versions): https://github.com/h4ckf0r0day/obscura/releases/tag/v0.2.2
- GitHub API latest release (asset inventory source the installer uses): https://api.github.com/repos/h4ckf0r0day/obscura/releases/latest
- crates.io `obscura` crate (the unrelated raytracing library): https://crates.io/crates/obscura

## Evidence: v0.2.2 release inventory (fetched 2026-09-20)

Latest release: v0.2.2, published 2026-09-05. Twenty assets, four variants per target, naming `obscura-<arch>-<os>[-<variant>].<ext>`. The installer does not call the API at runtime; this inventory is design evidence for the selection table.

| Target | Default (render) | `-stealth` | `-no-render` | `-no-render-stealth` |
|---|---|---|---|---|
| x86_64-windows | .zip 72,187,554 B | .zip 77,502,082 B | .zip 40,680,801 B | .zip 45,922,293 B |
| x86_64-macos | .tar.gz 77,974,380 B | .tar.gz 83,614,243 B | .tar.gz 45,545,709 B | .tar.gz 51,041,366 B |
| aarch64-macos | .tar.gz 76,038,298 B | .tar.gz 81,307,054 B | .tar.gz 43,712,950 B | .tar.gz 48,986,259 B |
| x86_64-linux | .tar.gz 80,522,848 B | .tar.gz 86,535,331 B | .tar.gz 47,869,877 B | .tar.gz 53,823,829 B |
| aarch64-linux | .tar.gz 82,303,494 B | .tar.gz 88,428,688 B | .tar.gz 49,600,923 B | .tar.gz 55,595,455 B |

No checksum files are published. The release notes confirm binaries self report their version at release time. Windows is x86_64 only; there is no Windows ARM asset, which is why AC-9 exists.
