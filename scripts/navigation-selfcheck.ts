// The runnable check for slice 1 (feature 6, core navigation and reading).
// Proves the whole loop against the real engine: start the supervised
// engine, navigate, read the page as markdown with interactive refs, follow
// history back and forward, reload, stop cleanly. Uses data: URLs because
// the engine refuses private and loopback addresses, so a local fixture
// server would be blocked.
//
// Run: node scripts/navigation-selfcheck.ts   (node 24 runs TypeScript directly)

import assert from "node:assert/strict";
import { goBack, goForward, navigate, readPage, reloadPage } from "../src/browser.js";
import { createEngineSupervisor } from "../src/supervisor.js";

const PAGE_A =
  "data:text/html,<title>Page A</title><h1>First Page</h1><p>Hello <a href='https://example.com/docs'>the docs</a></p><button id='go'>Go</button><input placeholder='your name'>";
const PAGE_B = "data:text/html,<title>Page B</title><p>Second page</p>";

async function main() {
  const engine = createEngineSupervisor();
  try {
    // Navigate and read page A.
    const openedA = await engine.runExclusive(undefined, (h) => navigate(h, PAGE_A, undefined));
    assert.equal(openedA.title, "Page A");
    assert.ok(openedA.url.startsWith("data:text/html"), "navigate reports the real URL");

    const readA = await engine.runExclusive(undefined, (h) => readPage(h, undefined));
    assert.equal(readA.title, "Page A");
    assert.ok(readA.markdown.includes("# First Page"), "heading renders as markdown");
    assert.ok(readA.markdown.includes("(https://example.com/docs)"), "link href renders");
    assert.deepEqual(
      readA.refs.map((r) => r.kind),
      ["link", "button", "input"],
      "refs number interactive elements in document order",
    );
    assert.equal(readA.refs[0].href, "https://example.com/docs", "link ref carries the href");
    assert.equal(readA.refs[0].text, "the docs", "link ref carries the link text");
    assert.equal(
      new Set(readA.refs.map((r) => r.node)).size,
      readA.refs.length,
      "every ref maps to a distinct backend node id",
    );

    // Second page, then history: back to A, forward to B again, reload stays on B.
    const openedB = await engine.runExclusive(undefined, (h) => navigate(h, PAGE_B, undefined));
    assert.equal(openedB.title, "Page B");

    const back = await engine.runExclusive(undefined, (h) => goBack(h, undefined));
    assert.equal(back.title, "Page A", "go back returns to the previous page");

    const forward = await engine.runExclusive(undefined, (h) => goForward(h, undefined));
    assert.equal(forward.title, "Page B", "go forward returns to the next page");

    const reloaded = await engine.runExclusive(undefined, (h) => reloadPage(h, undefined));
    assert.equal(reloaded.title, "Page B", "reload keeps the current page");

    // Reading again after navigation returns it, and the engine stayed one
    // process for all of it.
    const endRead = await engine.runExclusive(undefined, (h) => readPage(h, undefined));
    assert.ok(
      endRead.markdown.includes("Second page"),
      "the page reads correctly after history moves",
    );

    console.log("navigation and reading self-check passed");
  } finally {
    await engine.stopEngine();
  }
}

main().catch((error) => {
  console.error("self-check failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
