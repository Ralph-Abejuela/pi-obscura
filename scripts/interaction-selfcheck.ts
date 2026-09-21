// The runnable check for slice 2 (feature 7, interaction tools, spec 0006).
// Proves the whole action layer against the real engine: the refs contract
// extension, a multi step search, fill, and submit flow, click with the cover
// rule, fill and type semantics, choose, scroll, keys, every refusal case, the
// fresh refs discipline, and the engine limits the build recorded (the dropped
// modifier state, where a click lands when the cover check cannot see the cover,
// and which named keys the engine actually acts on). Uses data: URLs because the
// engine refuses private and loopback addresses, so a local fixture server
// would be blocked.
//
// Run: node node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs scripts/interaction-selfcheck.ts

import assert from "node:assert/strict";
import type { ReadRef } from "../src/browser.js";
import { navigate, readPage, send } from "../src/browser.js";
import { chooseRef, clickRef, fillRef, keyPress, scrollPage, typeRef } from "../src/interact.js";
import { createEngineSupervisor } from "../src/supervisor.js";

// The result page the search forms submit to. Its own attributes use double
// quotes: encodeURIComponent leaves single quotes raw, so a single quoted href
// would end the form action attribute early (found the hard way).
const RESULT_HTML =
  "<!doctype html><title>Search results</title><p>Found it</p>" +
  '<a href="https://example.com/x">docs</a>';
const RESULT_URL = `data:text/html,${encodeURIComponent(RESULT_HTML)}`;

// The interaction fixture: a fixed overlay covers the top band of the viewport
// (so a button placed there is refused as covered), and the search form,
// select, checkbox, textarea, nested button, password, and counter buttons all
// sit below it where their centers are clear. The form submits to the static
// RESULT_URL, so landing there proves the submit and the navigation both ran.
// The overlay is the LAST element in the body: this engine's elementFromPoint
// resolves in DOM order rather than stacking order, so a cover must follow the
// element it covers to be reported at all (probe verified on 0.2.2).
const PAGE_HTML =
  "<!doctype html><html><body>" +
  "<div style='height:260px'></div>" +
  `<form id='f' action='${RESULT_URL}'>` +
  "<input id='q' placeholder='search query'>" +
  "<button id='go' type='submit'>Search</button>" +
  "</form>" +
  "<select id='s'><option value='a'>Alpha</option><option value='b'>Beta</option></select>" +
  "<input type='checkbox' id='c'><label>agree</label>" +
  "<textarea id='t' placeholder='notes'></textarea>" +
  "<button id='nested' onclick=\"window.__nested=(window.__nested||0)+1\"><span>Nested</span></button>" +
  "<input type='password' id='p' placeholder='password'>" +
  "<button id='count' onclick=\"window.__count=(window.__count||0)+1\">Count</button>" +
  "<script>window.__change=0;window.__keys=[];" +
  "document.addEventListener('keydown',function(e){window.__keys.push(e.key+':'+e.isTrusted)});" +
  "document.getElementById('s').addEventListener('change',function(){window.__change++})</script>" +
  "<button id='covered' style='position:fixed;top:140px;left:300px'>Covered</button>" +
  "<div id='overlay' style='position:fixed;top:0;left:0;width:100%;height:200px;background:#ddd;z-index:10'></div>" +
  "</body></html>";
const PAGE_URL = `data:text/html,${encodeURIComponent(PAGE_HTML)}`;

// A tall page for the scroll checks: a button 4000px down, reachable only by
// scrolling.
const TALL_URL = `data:text/html,${encodeURIComponent(
  "<!doctype html><html><body><p>Top</p><div style='height:4000px'></div>" +
    "<button id='far'>Far down</button></body></html>",
)}`;

// The cover blind spot fixture (spec 0006 follow up): elementFromPoint resolves
// in document order on this engine, so a cover that PRECEDES the target is not
// detected and the cover check passes. This page puts the overlay first and the
// button inside its band, then records which element the engine's own mouse
// dispatch actually hit. The true element under the point is the overlay, so a
// hit on the button means the tool reported the target while the page saw the
// cover.
const BLIND_URL = `data:text/html,${encodeURIComponent(
  "<!doctype html><html><body>" +
    "<div id='first' style='position:fixed;top:0;left:0;width:100%;height:200px;background:#ddd;z-index:10'></div>" +
    "<button id='blind' style='position:fixed;top:80px;left:300px'>Blind</button>" +
    "<script>window.__hits=[];document.addEventListener('click',function(e){" +
    "window.__hits.push(e.target.id||e.target.tagName)},true)</script>" +
    "</body></html>",
)}`;

type Engine = ReturnType<typeof createEngineSupervisor>;

// A fixture ref must exist; a missing one fails the check loudly, not with a
// TypeError later.
function requireRef(refs: ReadRef[], match: (r: ReadRef) => boolean, what: string): ReadRef {
  const found = refs.find(match);
  if (!found) throw new Error(`self-check fixture missing ${what}`);
  return found;
}

async function evaluate(engine: Engine, expression: string): Promise<unknown> {
  const response = (await engine.runExclusive(undefined, (h) =>
    send(h, "Runtime.evaluate", { expression, returnByValue: true }),
  )) as { result?: { value?: unknown } };
  return response?.result?.value;
}

async function main() {
  const engine = createEngineSupervisor();
  try {
    // --- refs contract: input kinds and select options on the read result ---
    await engine.runExclusive(undefined, (h) => navigate(h, PAGE_URL, undefined));
    const readA = await engine.runExclusive(undefined, (h) => readPage(h, undefined));
    const queryRef = requireRef(readA.refs, (r) => r.text === "search query", "the search input");
    assert.equal(queryRef.inputType, "text", "an input ref names its type (AC-2 contract)");
    const selectRef = requireRef(readA.refs, (r) => r.kind === "select", "the select");
    assert.deepEqual(
      selectRef.options,
      [
        { label: "Alpha", value: "a" },
        { label: "Beta", value: "b" },
      ],
      "a select ref lists its option labels and values (AC-2 contract)",
    );
    assert.ok(
      readA.markdown.includes("options: Alpha (a), Beta (b)"),
      "the read output shows the select options",
    );
    assert.ok(readA.markdown.includes("type text"), "the read output shows the input type");

    // --- fill replaces, type appends (AC-3) ---
    let report = await engine.runExclusive(undefined, (h) =>
      fillRef(h, queryRef.ref, "hello", undefined),
    );
    assert.ok(report.refs.length > 0, "every action result carries fresh refs (AC-2)");
    assert.equal(
      await evaluate(engine, "document.getElementById('q').value"),
      "hello",
      "fill replaces the value",
    );

    report = await engine.runExclusive(undefined, (h) =>
      typeRef(h, queryRef.ref, " world", undefined),
    );
    assert.equal(
      await evaluate(engine, "document.getElementById('q').value"),
      "hello world",
      "type appends to the value",
    );

    // --- Enter on the focused search input submits the form (AC-4, AC-8) ---
    // The input keeps focus after the trusted text events; a trusted Enter now
    // performs the native implicit form submission and lands on RESULT_URL.
    report = await engine.runExclusive(undefined, (h) => keyPress(h, { key: "Enter" }, undefined));
    assert.equal(report.title, "Search results", "Enter submits the focused form (AC-4)");
    assert.ok(
      report.refs.length === 1 && report.refs[0].href === "https://example.com/x",
      "the fresh refs describe the new page, not the old one (AC-2)",
    );
    assert.ok(
      report.url.startsWith("data:text/html"),
      "the result reports the page the action landed on",
    );

    // --- stale ref: an old ref after navigation is refused (AC-2) ---
    await engine.runExclusive(undefined, (h) => navigate(h, PAGE_URL, undefined));
    const searchRef = requireRef(
      (await engine.runExclusive(undefined, (h) => readPage(h, undefined))).refs,
      (r) => r.text === "Search",
      "the Search button",
    );
    await engine.runExclusive(undefined, (h) => navigate(h, RESULT_URL, undefined));
    await assert.rejects(
      engine.runExclusive(undefined, (h) => clickRef(h, searchRef.ref, undefined)),
      /latest snapshot|fresh refs/,
      "a ref from before the navigation is refused in plain words",
    );

    // --- covered element: refused, naming the cover (AC-1, AC-7) ---
    await engine.runExclusive(undefined, (h) => navigate(h, PAGE_URL, undefined));
    const readB = await engine.runExclusive(undefined, (h) => readPage(h, undefined));
    const coveredRef = requireRef(readB.refs, (r) => r.text === "Covered", "the covered button");
    await assert.rejects(
      engine.runExclusive(undefined, (h) => clickRef(h, coveredRef.ref, undefined)),
      /is covered at its center by div#overlay/,
      "a click whose center is covered refuses and names the cover",
    );

    // --- click on a target whose center hits a descendant counts clear (AC-1) ---
    const nestedRef = requireRef(readB.refs, (r) => r.text === "Nested", "the nested button");
    const clickReport = await engine.runExclusive(undefined, (h) =>
      clickRef(h, nestedRef.ref, undefined),
    );
    assert.equal(clickReport.label, "Nested", "the click report names the element it hit");
    assert.equal(
      await evaluate(engine, "window.__nested || 0"),
      1,
      "the trusted click fired the button handler",
    );

    // --- choose: by label, by value, and a missing option refusal (AC-5) ---
    const readC = await engine.runExclusive(undefined, (h) => readPage(h, undefined));
    const selectRef2 = requireRef(readC.refs, (r) => r.kind === "select", "the select");
    await engine.runExclusive(undefined, (h) => chooseRef(h, selectRef2.ref, "Beta", undefined));
    assert.equal(
      await evaluate(engine, "document.getElementById('s').value"),
      "b",
      "an option matched by label text sets its value",
    );
    assert.equal(await evaluate(engine, "window.__change"), 1, "the change event fired");
    await engine.runExclusive(undefined, (h) => chooseRef(h, selectRef2.ref, "a", undefined));
    assert.equal(
      await evaluate(engine, "document.getElementById('s').value"),
      "a",
      "an option matched by its value attribute sets its value",
    );
    await assert.rejects(
      engine.runExclusive(undefined, (h) => chooseRef(h, selectRef2.ref, "bogus", undefined)),
      /no option "bogus". Valid options: Alpha \(a\), Beta \(b\)/,
      "a missing option refuses and lists the valid labels and values",
    );

    // --- fill on a non text kind refuses, naming the kind (AC-3, AC-7) ---
    const readD = await engine.runExclusive(undefined, (h) => readPage(h, undefined));
    const checkboxRef = requireRef(readD.refs, (r) => r.inputType === "checkbox", "the checkbox");
    await assert.rejects(
      engine.runExclusive(undefined, (h) => fillRef(h, checkboxRef.ref, "x", undefined)),
      /is a checkbox, not a text input/,
      "fill on a checkbox refuses, naming the kind",
    );

    // --- a modifier argument is refused, naming the engine limit (AC-4, AC-7) ---
    await assert.rejects(
      engine.runExclusive(undefined, (h) =>
        keyPress(h, { key: "a", modifiers: ["ctrl"] }, undefined),
      ),
      /drops modifier state/,
      "a modifier combo is refused in plain words, naming the engine limit",
    );

    // --- a single character is accepted (AC-4) ---
    await engine.runExclusive(undefined, (h) =>
      keyPress(h, { key: "/", ref: queryRef.ref }, undefined),
    );
    assert.equal(
      await evaluate(engine, "document.getElementById('q').value"),
      "/",
      "a single character key reaches the focused input",
    );

    // --- an unknown key is refused with the valid names (AC-4, AC-7) ---
    await assert.rejects(
      engine.runExclusive(undefined, (h) => keyPress(h, { key: "Frobnicate" }, undefined)),
      /unknown key "Frobnicate". Use a named key/,
      "an unknown key name is refused with the valid names",
    );

    // --- Enter on a focused submit control (via its ref) submits (AC-4) ---
    const readE = await engine.runExclusive(undefined, (h) => readPage(h, undefined));
    const goRef = requireRef(readE.refs, (r) => r.text === "Search", "the Search button");
    report = await engine.runExclusive(undefined, (h) =>
      keyPress(h, { key: "Enter", ref: goRef.ref }, undefined),
    );
    assert.equal(report.title, "Search results", "Enter on the focused submit button submits");

    // --- a named key reaches the page as a trusted keydown (AC-4) ---
    // This engine performs no native action for Tab (no focus traversal), so the
    // assertion is the delivery AC-4 promises: the page sees the trusted event.
    // Which named keys have a native effect is probe recorded in the rationale:
    // only Enter (implicit submit) and Backspace (edit).
    await engine.runExclusive(undefined, (h) => navigate(h, PAGE_URL, undefined));
    const readF = await engine.runExclusive(undefined, (h) => readPage(h, undefined));
    const goRef2 = requireRef(readF.refs, (r) => r.text === "Search", "the Search button");
    await engine.runExclusive(undefined, (h) =>
      keyPress(h, { key: "Tab", ref: goRef2.ref }, undefined),
    );
    assert.ok(
      ((await evaluate(engine, "JSON.stringify(window.__keys || [])")) as string).includes(
        '"Tab:true"',
      ),
      "the page sees the named key as a trusted keydown",
    );
    assert.equal(
      await evaluate(engine, "document.activeElement && document.activeElement.id"),
      "go",
      "Tab does not move focus: the engine performs no native traversal (probe recorded)",
    );

    // --- scroll: by amount, signed, and a ref into view (AC-6) ---
    await engine.runExclusive(undefined, (h) => navigate(h, TALL_URL, undefined));
    let pos = await engine.runExclusive(undefined, (h) => scrollPage(h, { by: 300 }, undefined));
    assert.equal(pos.scrollY, 300, "scroll by a positive amount moves down");
    pos = await engine.runExclusive(undefined, (h) => scrollPage(h, { by: -200 }, undefined));
    assert.equal(pos.scrollY, 100, "scroll by a negative amount moves up");
    assert.equal(pos.refs.length, 1, "scroll results carry fresh refs (AC-2)");
    const tallRef = pos.refs[0];
    assert.equal(tallRef.text, "Far down", "the tall page's button is the one interactive element");
    pos = await engine.runExclusive(undefined, (h) =>
      scrollPage(h, { ref: tallRef.ref }, undefined),
    );
    // No magic pixel count: the element is the last thing on the page, so
    // centering it lands at the bottom of the scroll range, whatever this
    // engine's viewport height happens to be.
    const maxScroll = (await evaluate(
      engine,
      "document.documentElement.scrollHeight - window.innerHeight",
    )) as number;
    assert.ok(
      pos.scrollY > maxScroll - 50,
      `scroll a ref into view reaches the bottom of the page (${pos.scrollY} of ${maxScroll})`,
    );
    const visible = (await evaluate(
      engine,
      "(function(){var r=document.getElementById('far').getBoundingClientRect();return r.top > 0 && r.top < window.innerHeight})()",
    )) as boolean;
    assert.equal(visible, true, "the scrolled element is on screen");

    // --- the cover blind spot: where does the click land when the check passes (AC-1) ---
    await engine.runExclusive(undefined, (h) => navigate(h, BLIND_URL, undefined));
    const readH = await engine.runExclusive(undefined, (h) => readPage(h, undefined));
    const blindRef = requireRef(readH.refs, (r) => r.text === "Blind", "the blind spot button");
    await engine.runExclusive(undefined, (h) => clickRef(h, blindRef.ref, undefined));
    console.log(
      "cover blind spot probe: the click was accepted, the page saw",
      await evaluate(engine, "JSON.stringify(window.__hits || [])"),
    );

    // --- concurrency: the queue serializes actions (AC-9) ---
    await engine.runExclusive(undefined, (h) => navigate(h, PAGE_URL, undefined));
    const readG = await engine.runExclusive(undefined, (h) => readPage(h, undefined));
    const countRef = requireRef(readG.refs, (r) => r.text === "Count", "the count button");
    await Promise.all([
      engine.runExclusive(undefined, (h) => clickRef(h, countRef.ref, undefined)),
      engine.runExclusive(undefined, (h) => clickRef(h, countRef.ref, undefined)),
    ]);
    assert.equal(
      await evaluate(engine, "window.__count || 0"),
      2,
      "two concurrent clicks both land, serialized by the queue",
    );

    console.log("interaction tools self-check passed");
  } finally {
    await engine.stopEngine();
  }
}

main().catch((error) => {
  console.error("self-check failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
