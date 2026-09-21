// The runnable check for slice 3 (feature 8, script and wait, spec 0007).
// Proves the whole script and wait layer against the real engine: the eval
// value contract and its degradations, the ref form, the await flag, every page
// error shape, the wait's three modes and its verdicts, the refusals, the
// clamps, the abort path, a navigation under a polling wait, and the queue
// discipline (a read behind a wait). Uses data: URLs because the engine refuses
// private and loopback addresses. The 30 second cases (an awaited promise that
// never settles, and the `while (true) {}` page wedge) are left to /check
// verify, which runs them last.
//
// Run: node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs scripts/script-selfcheck.ts

import assert from "node:assert/strict";
import type { ReadRef } from "../src/browser.js";
import { navigate, readPage, send } from "../src/browser.js";
import { evalInPage, waitForMatch } from "../src/script.js";
import { createEngineSupervisor } from "../src/supervisor.js";

// The wait fixture. Every literal the checks wait for is built by concatenation
// inside the page's own script: this engine's innerText equals its textContent,
// so a literal sitting in the script source would match a text wait at once.
const WAIT_HTML =
  "<!doctype html><html><body>" +
  "<title>Wait fixture</title>" +
  "<p id='seed'>Start here</p>" +
  "<button id='go'>Go</button>" +
  "<input id='q' placeholder='query'>" +
  "<script>" +
  "window.__flag=false;" +
  "setTimeout(function(){window.__flag=true},300);" +
  "setTimeout(function(){var p=document.createElement('p');p.id='late';" +
  "p.textContent='Late'+' text arrived';document.body.appendChild(p)},400);" +
  "setTimeout(function(){var d=document.createElement('div');d.id='latebox';" +
  "d.textContent='boxed';document.body.appendChild(d)},600);" +
  "</script>" +
  "</body></html>";
const WAIT_URL = `data:text/html,${encodeURIComponent(WAIT_HTML)}`;

// The page a mid wait navigation lands on: its text arrives after the
// navigation, so the wait has to survive the navigation and keep polling.
const MOVED_HTML =
  "<!doctype html><html><body><title>Moved</title><p id='here'></p>" +
  "<button id='after'>After</button><script>" +
  "setTimeout(function(){document.getElementById('here').textContent='target'+' text here'},300)" +
  "</script></body></html>";
const MOVED_URL = `data:text/html,${encodeURIComponent(MOVED_HTML)}`;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A fixture ref must exist; a missing one fails the check loudly.
function requireRef(refs: ReadRef[], match: (r: ReadRef) => boolean, what: string): ReadRef {
  const found = refs.find(match);
  if (!found) throw new Error(`self-check fixture missing ${what}`);
  return found;
}

async function main() {
  const engine = createEngineSupervisor();
  try {
    await engine.runExclusive(undefined, (h) => navigate(h, WAIT_URL, undefined));
    const staleRead = await engine.runExclusive(undefined, (h) => readPage(h, undefined));
    const goRef = requireRef(staleRead.refs, (r) => r.text === "Go", "the Go button");
    // The stale ref case needs a ref the NEXT page does not hold. Ref numbers
    // are per page and are reused, so a ref from the old page only reads as
    // stale when the new page issues fewer refs: the input is the second ref
    // here, and the moved fixture has exactly one interactive element.
    const inputRef = requireRef(staleRead.refs, (r) => r.text === "query", "the query input");

    // --- AC-1: a plain expression, a statement script, and a value with a type ---
    let report = await engine.runExclusive(undefined, (h) =>
      evalInPage(h, { expression: "1 + 1" }, undefined),
    );
    assert.equal(report.value, "2", "a plain expression reports its completion value");
    assert.equal(report.type, "number", "the result reports the JavaScript type");
    assert.equal(report.truncated, false, "a small value is not truncated");
    assert.ok(report.url.startsWith("data:text/html"), "the result reports where the page is");

    report = await engine.runExclusive(undefined, (h) =>
      evalInPage(h, { expression: "const a = 1; a + 1" }, undefined),
    );
    assert.equal(report.value, "2", "a statement list reports its completion value");

    report = await engine.runExclusive(undefined, (h) =>
      evalInPage(h, { expression: "if (true) { 5 }" }, undefined),
    );
    assert.equal(report.value, "5", "a statement script reports its completion value");

    // --- AC-2: the ref form runs the expression with the element as `this` ---
    report = await engine.runExclusive(undefined, (h) =>
      evalInPage(h, { expression: "return this.textContent", ref: goRef.ref }, undefined),
    );
    assert.equal(report.value, '"Go"', "the ref form returns a value from the element");
    assert.equal(report.type, "string", "the ref form reports the type too");
    assert.equal(report.ref, goRef.ref, "the result names the ref it ran against");

    report = await engine.runExclusive(undefined, (h) =>
      evalInPage(h, { expression: "this.textContent", ref: goRef.ref }, undefined),
    );
    assert.equal(
      report.value,
      "null",
      "with a ref the expression is a function body, so without return the value is undefined",
    );

    // --- AC-1: the values this engine degrades are named, never dumped ---
    report = await engine.runExclusive(undefined, (h) =>
      evalInPage(h, { expression: "document.getElementById('go')" }, undefined),
    );
    assert.equal(report.value, "(a DOM element)", "a DOM element is not dumped");
    assert.ok(/DOM element/.test(report.note ?? ""), "the element note says what it was");

    report = await engine.runExclusive(undefined, (h) =>
      evalInPage(h, { expression: "new Promise(function(){})" }, undefined),
    );
    assert.equal(report.value, "{}", "a promise reads as the empty object the engine sends");
    assert.ok(
      /await: true/.test(report.note ?? ""),
      "the empty object note names await: true as the fix",
    );

    report = await engine.runExclusive(undefined, (h) =>
      evalInPage(h, { expression: "new Map([['a', 1]])" }, undefined),
    );
    assert.equal(report.value, "{}", "a Map reads as an empty object too");
    assert.ok(/Map/.test(report.note ?? ""), "the note names the Map among the possible values");

    report = await engine.runExclusive(undefined, (h) =>
      evalInPage(h, { expression: "null" }, undefined),
    );
    assert.equal(report.value, "null", "null reads as null");
    assert.ok(
      /undefined, null, and NaN/.test(report.note ?? ""),
      "the null reading names the ambiguity rather than guessing",
    );

    report = await engine.runExclusive(undefined, (h) =>
      evalInPage(h, { expression: "window" }, undefined),
    );
    assert.ok(
      report.value.includes("[object Object]"),
      "window is reported as the ordinary string the engine actually sent",
    );

    // --- AC-1: the cap reports how much was dropped ---
    report = await engine.runExclusive(undefined, (h) =>
      evalInPage(h, { expression: "'x'.repeat(25000)" }, undefined),
    );
    assert.equal(report.truncated, true, "a value over the cap is marked truncated");
    assert.equal(report.value.length, 20_000, "the value is cut at the code constant cap");
    assert.ok(
      /is 2500[0-9] characters; the first 20000 are shown/.test(report.note ?? ""),
      "the note says how much was dropped",
    );

    // --- AC-3: await off reports a promise as {}, await on returns its value ---
    report = await engine.runExclusive(undefined, (h) =>
      evalInPage(
        h,
        { expression: "new Promise(function(r){setTimeout(function(){r(42)},200)})", await: true },
        undefined,
      ),
    );
    assert.equal(report.value, "42", "await: true returns the settled promise value");

    report = await engine.runExclusive(undefined, (h) =>
      evalInPage(
        h,
        {
          expression: "return new Promise(function(r){setTimeout(function(){r('late')},200)})",
          await: true,
          ref: goRef.ref,
        },
        undefined,
      ),
    );
    assert.equal(report.value, '"late"', "await: true works on the ref path too");

    // --- AC-4: every page error shape reads in plain words ---
    await assert.rejects(
      engine.runExclusive(undefined, (h) =>
        evalInPage(h, { expression: "throw new Error('boom')" }, undefined),
      ),
      /the page's own script threw: Error: boom/,
      "a thrown error comes from the response's exception details",
    );
    await assert.rejects(
      engine.runExclusive(undefined, (h) => evalInPage(h, { expression: "const = ;" }, undefined)),
      /SyntaxError/,
      "a syntax error reads as the page's own message",
    );
    await assert.rejects(
      engine.runExclusive(undefined, (h) =>
        evalInPage(h, { expression: "return this.nope.deep", ref: goRef.ref }, undefined),
      ),
      /the page's own script threw: TypeError/,
      "a page error on the ref path reads the JS error protocol shape",
    );

    // --- AC-4: the session stays usable after a page error ---
    report = await engine.runExclusive(undefined, (h) =>
      evalInPage(h, { expression: "2 + 2" }, undefined),
    );
    assert.equal(report.value, "4", "the next call works after a page error");

    // --- AC-2: a ref the fresh snapshot does not hold is refused ---
    await engine.runExclusive(undefined, (h) => navigate(h, MOVED_URL, undefined));
    const movedRead = await engine.runExclusive(undefined, (h) => readPage(h, undefined));
    assert.ok(
      !movedRead.refs.some((ref) => ref.ref === inputRef.ref),
      "fixture check: the moved page must not reuse the old ref number, or the refusal cannot be tested",
    );
    await assert.rejects(
      engine.runExclusive(undefined, (h) =>
        evalInPage(h, { expression: "return this.textContent", ref: inputRef.ref }, undefined),
      ),
      /latest snapshot|fresh refs/,
      "a stale ref on the eval ref path is refused in plain words",
    );

    // --- AC-5, AC-6, AC-7: the wait's modes, verdicts, and refusals ---
    await engine.runExclusive(undefined, (h) => navigate(h, WAIT_URL, undefined));
    let waited = await engine.runExclusive(undefined, (h) =>
      waitForMatch(h, { text: "Late text arrived", timeoutMs: 5_000 }, undefined),
    );
    assert.equal(waited.appeared, true, "a wait on text finds text that appears late");
    assert.equal(waited.mode, "text", "the verdict names the mode it used");
    assert.equal(waited.watched, "Late text arrived", "the verdict names what it watched");
    assert.ok(waited.elapsedMs >= 300, `the wait really waited (${waited.elapsedMs} ms)`);
    assert.ok(waited.refs.length > 0, "a matched wait carries fresh refs");
    assert.ok(waited.url.startsWith("data:text/html"), "a matched wait names where the page is");
    assert.equal(waited.title, "Wait fixture", "a matched wait carries the title");

    waited = await engine.runExclusive(undefined, (h) =>
      waitForMatch(h, { selector: "#latebox", timeoutMs: 5_000 }, undefined),
    );
    assert.equal(waited.appeared, true, "a wait on a selector finds a late element");
    assert.equal(waited.mode, "selector", "the selector verdict names its mode");

    waited = await engine.runExclusive(undefined, (h) =>
      waitForMatch(h, { condition: "window.__flag === true", timeoutMs: 5_000 }, undefined),
    );
    assert.equal(waited.appeared, true, "a wait on a condition polls the caller's own expression");

    // A wait that runs out of time is a normal result, not an error (AC-8).
    waited = await engine.runExclusive(undefined, (h) =>
      waitForMatch(h, { text: "nothing on this page says this", timeoutMs: 500 }, undefined),
    );
    assert.equal(waited.appeared, false, "a wait that ran out of time reports appeared: false");
    assert.ok(waited.elapsedMs >= 450, "the honest verdict reports how long it waited");
    assert.ok(waited.refs.length > 0, "the not matched path carries fresh refs too (AC-9)");
    assert.equal(waited.url.startsWith("data:text/html"), true, "and where the page is");
    assert.equal(waited.notes.length, 0, "500 ms is inside the range, so there is no clamp note");

    // A mistyped selector: this engine returns null rather than throwing, so the
    // verdict names the selector (AC-6).
    waited = await engine.runExclusive(undefined, (h) =>
      waitForMatch(h, { selector: "[[", timeoutMs: 500 }, undefined),
    );
    assert.equal(waited.appeared, false, "a malformed selector reads as no match, not a crash");
    assert.ok(
      waited.notes.some((note) => /mistyped selector/.test(note) && note.includes("[[")),
      "the selector verdict names the selector and the engine's null behaviour",
    );

    // --- AC-5, AC-7, AC-11: the refusals and the clamp ---
    await assert.rejects(
      engine.runExclusive(undefined, (h) => waitForMatch(h, {}, undefined)),
      /needs one of text, selector, or condition/,
      "zero modes are refused in plain words",
    );
    await assert.rejects(
      engine.runExclusive(undefined, (h) =>
        waitForMatch(h, { text: "a", selector: "b" }, undefined),
      ),
      /exactly one of text, selector, or condition.*not text and selector/,
      "two modes are refused in plain words",
    );
    waited = await engine.runExclusive(undefined, (h) =>
      waitForMatch(h, { text: "Start here", timeoutMs: 10 }, undefined),
    );
    assert.equal(waited.appeared, true, "a clamped wait still matches");
    assert.ok(
      waited.notes.some((note) => /outside 500 to 25000 ms/.test(note)),
      "an out of range timeout is clamped with a note naming the clamp",
    );

    // --- AC-11: a throwing condition is refused at the first tick ---
    const threwAt = Date.now();
    await assert.rejects(
      engine.runExclusive(undefined, (h) =>
        waitForMatch(
          h,
          { condition: "document.getElementById('nope').value", timeoutMs: 5_000 },
          undefined,
        ),
      ),
      /the page's own script threw: TypeError/,
      "a condition that throws is refused in plain words",
    );
    assert.ok(
      Date.now() - threwAt < 1_500,
      "a throwing condition is refused at the first tick, not after the clock",
    );

    // --- AC-10, AC-13: an aborted wait stops at once and frees the queue ---
    const controller = new AbortController();
    const aborting = engine.runExclusive(controller.signal, (h) =>
      waitForMatch(
        h,
        { text: "nothing on this page says this", timeoutMs: 5_000 },
        controller.signal,
      ),
    );
    await pause(300);
    controller.abort();
    const abortAt = Date.now();
    await assert.rejects(aborting, /cancelled/, "an aborted wait fails with the cancellation");
    assert.ok(
      Date.now() - abortAt < 1_000,
      "the aborted wait stopped at once instead of polling out its own clock",
    );
    const afterAbort = await engine.runExclusive(undefined, (h) => readPage(h, undefined));
    assert.ok(
      afterAbort.url.startsWith("data:text/html"),
      "the queue is free and the session usable after an aborted wait",
    );

    // --- AC-10, AC-13: a read issued while a wait is polling runs after it ---
    await engine.runExclusive(undefined, (h) => navigate(h, WAIT_URL, undefined));
    const waitStarted = Date.now();
    const waiting = engine.runExclusive(undefined, (h) =>
      waitForMatch(h, { text: "Late text arrived", timeoutMs: 5_000 }, undefined),
    );
    let readStartedAt = 0;
    const reading = engine.runExclusive(undefined, async (h) => {
      readStartedAt = Date.now();
      return readPage(h, undefined);
    });
    const blockedWait = await waiting;
    assert.equal(blockedWait.appeared, true, "the wait still matched with a read queued behind it");
    const blockedRead = await reading;
    assert.ok(
      readStartedAt - waitStarted >= 200,
      "the read waited for the wait to finish instead of interleaving",
    );
    assert.ok(
      blockedRead.markdown.includes("Late text arrived"),
      "the read reports the post wait page state",
    );

    // --- AC-11, AC-13: a navigation under the wait is absorbed, not read as a
    // broken condition, and the wait sees the new page ---
    await engine.runExclusive(undefined, (h) => navigate(h, WAIT_URL, undefined));
    const handle = await engine.ensureEngine(undefined);
    const surviving = engine.runExclusive(undefined, (h) =>
      waitForMatch(h, { text: "target text here", timeoutMs: 8_000 }, undefined),
    );
    await pause(400);
    await send(handle, "Page.navigate", { url: MOVED_URL });
    const afterNav = await surviving;
    assert.equal(afterNav.appeared, true, "a wait survives a page navigating under it");
    assert.equal(afterNav.title, "Moved", "the verdict reports the page it ended on");
    assert.ok(
      afterNav.refs.some((ref) => ref.text === "After"),
      "the verdict's refs come from the page it ended on, not the one it started on",
    );

    console.log("script and wait self-check passed");
  } finally {
    await engine.stopEngine();
  }
}

main().catch((error) => {
  console.error("self-check failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
