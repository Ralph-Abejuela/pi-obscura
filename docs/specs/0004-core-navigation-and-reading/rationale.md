# Rationale: core navigation and reading

The decision record for spec 0004. `/develop` does not read this file; the build spec lives in `index.md`.

## Context

The plugin exists to give the pi agent a real browsing engine, and this feature is the loop that makes the engine useful: open a page, see what is on it as readable text with the interactive elements named, and move around. Pi has no built in browser tools, so this slice owns the whole reading and navigation surface. The contract in the scope is short: open a URL, read the page as markdown with interactive element references, follow links, and go back, forward, and reload through pi tools.

The architecture was already decided in spec 0001: raw CDP over chrome-remote-interface, one persistent connection per session, reading by DOM snapshot serialized to markdown, interactive elements referenced by CDP backend node IDs, tools named with a `browser_` prefix, a shared queue so CDP work never interleaves, 30 second tool timeouts, and errors mapped to four plain categories. When the build ran against the real engine (obscura 0.2.2), three assumptions in that contract did not hold as written, and each had to be settled by measuring the engine live rather than assuming Chrome behavior. This spec records those settlements and the concrete tool surface that resulted.

The decision record covers four things: how the page is read, how the session page is obtained, how history traversal works, and what fidelity costs the slice accepts. None of these were open questions before the build; they were discovered, measured, and settled during it, and this record exists so the next slice builds against recorded reality instead of re deriving it.

## Options considered

### Option 1: Read by DOM snapshot serialization (chosen)

The read tool captures a CDP DOM snapshot (`DOMSnapshot.captureSnapshot`) and serializes the document to markdown in the extension, numbering only the interactive elements (links, buttons, inputs, selects, textareas) in document order and mapping each ref to the node's backend ID. This is the approach spec 0001 chose.

**Pros**:
- Deterministic: the same page yields the same markdown shape, no scripts run in the page.
- Refs are backend node IDs from a snapshot the agent actually saw, which keeps later interaction tools honest.
- Runs over raw CDP with no engine specific dependency beyond the snapshot call itself.

**Cons**:
- Plain fidelity: no bold or italic, tables flatten to lines, and elements a human would not see (hidden by styling, offscreen) can appear in the text.
- The snapshot is a DOM tree, so any content the page keeps in the DOM but hides visually still shows up in the markdown.

### Option 2: Read by readability style script in the page

An in page script (Readability style extraction) run through `Runtime.evaluate` that reduces an article page to its main content.

**Pros**: much higher fidelity for article pages, the classic read mode the majority of reading tools ship.

**Cons**: runs scripts in the page (changes the page's environment and is non deterministic across pages), is an opt in mode that needs its own extraction pipeline, and hides the ingredients a plain read shows. Spec 0001 deferred this to a later slice; the scope carries it as a deferred item.

### Option 3: Read by raw text dump

Extract visible text directly (for example by finding the body and walking text nodes) with no markdown structure.

**Pros**: smallest code, trivial to reason about.

**Cons**: loses the structure the agent needs (headings, link targets, which element is interactive); the markdown plus refs shape is what makes the tool useful for acting later. Rejected at the stack level in 0001.

### History traversal: Page.goBack, page history.back(), or the engine's history entries (chosen)

Back and forward were assumed to ride on `Page.goBack` and `Page.goForward`, the Chrome surface. Measured live, the engine knows neither method ("Unknown Page method"), and a page `history.back()` through `Runtime.evaluate` is a no-op that never moves the page. What does work is the engine's own history stack: `Page.getNavigationHistory` returns the entries, and `Page.navigateToHistoryEntry` traverses to one of them, verified moving both directions in the live probe.

**Pros**: uses the engine's native, truthful history (redirects and in page navigations that the engine records are included), and keeps the plugin free of a parallel URL stack to stay in sync.

**Cons**: rides on two CDP methods that a future engine release could drop or change; the watch item in `index.md` covers that with a plugin side URL stack as the fallback.

### Session page: rely on a listed target, or create it (chosen)

The connection contract in 0001 assumed the engine lists its page target in `Target.getTargets`. Measured live, obscura 0.2.2 lists no targets until one exists, and page methods on the root session fail with "No page for session". The supervisor now creates the one session page with `Target.createTarget` at connect and attaches to it. Engines that do list a target (or connect straight to a page session) keep their existing path.

### Snapshot shape: the shared strings array

`DOMSnapshot.captureSnapshot` on this engine returns one shared `strings` array at the response level, with per document fields (title, URL, node values, attributes) holding indexes into it, and a flat nodes array governed by `parentIndex` alone (no `childNodeIndexes`). The serializer reads the shared array and rebuilds the tree from parent indexes. Deviates from the Chrome layout the protocol document describes, but is consistent across probe runs on 0.2.2.

## Rationale

The reading approach was not re litigated: spec 0001 chose DOM snapshot serialization and the build confirmed it works on the real engine, so it stands, with its accepted costs (plain fidelity, main frame only, truncation cap) recorded in consequences. A readability mode remains the scoped, deferred follow up for heavy article pages.

The other three settlements came from measurement, not preference. Each was tried live against the engine before being adopted: the page target had to be created because none exists at connect; history traversal uses the engine's entries because the Chrome surface is absent and the page level fallback is inert; and the snapshot reading follows the shape the engine actually returns. Recording them as decisions protects the next slices (interaction tools resolve refs by backend node ID exactly as fixed here) from re discovering the same surprises.

The engineer confirmed this account at design time: the DOM snapshot reading approach, the createTarget plus history entries mechanisms, and the tradeoff list (plain markdown, main frame only, truncation at 60000 characters, private address refusal) were each presented and accepted verbatim. Nothing here is speculative; every mechanism named was exercised in the build's live probe and self check.

References were declined for this run (the decision is grounded in the repo: spec 0001's contract, the scope's Done when line, and engine behavior observed directly), so no References section appears.