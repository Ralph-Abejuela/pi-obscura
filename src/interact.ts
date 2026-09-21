// src/interact.ts
// The action tools (slice 2, feature 7, spec 0006): click, fill, type,
// choose, scroll, and key act on the refs a fresh read or action snapshot
// holds. Every operation runs through the supervisor queue inside runOp, so
// the same 30 second clock, caller abort signal, and plain error categories
// that bound the navigation and reading tools also bound these.
//
// The input strategy was verified live against obscura 0.2.2 in the spec 0006
// probes (scratch/probe-interact*.ts): trusted Input domain dispatch works for
// mouse, keys, and insertText; DOM.resolveNode hands a backend node id to
// Runtime.callFunctionOn for the evaluate side work; DOM.getBoxModel is in
// layout coordinates (document), and Input.dispatchMouseEvent wants viewport
// coordinates, so the box center is shifted by the current scroll position;
// DOM.pushNodesByBackendIdsToFrontend and DOM.getNodeForLocation do not exist
// on this engine, which is why the cover check goes through elementFromPoint
// instead. Select value + change and scrolling stay on the evaluate path
// because they are untrusted by design (a page that verifies the user gesture
// on select or scroll could misbehave; click, typing, and keys are trusted).

import type { ReadRef } from "./browser.js";
import { runOp, send, snapshotRefs, waitForReady } from "./browser.js";
// The engine handle type lives in the supervisor; browser.ts uses it but does
// not re-export it, so actions import it from the source.
import type { EngineHandle } from "./supervisor.js";

// spec 0006: the quiet delay before the post action snapshot, so a page still
// settling when the ready state flips does not snapshot mid change.
const QUIET_DELAY_MS = 300;

// spec 0006 AC-3: fill and type accept text like input kinds and textareas
// only. Anything else (checkbox, radio, file, button, submit, select, color,
// range, and so on) is refused with the element kind named.
const TEXT_LIKE_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
]);

// spec 0006 AC-4: named keys, each with the code and virtual key code the
// engine wants for a trusted Input.dispatchKeyEvent.
const KEY_MAP: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
};

export interface InteractionReport {
  refs: ReadRef[];
  url: string;
  title: string;
  scrollX: number;
  scrollY: number;
}

export interface ClickReport extends InteractionReport {
  /** The element label from the pre action snapshot, what the click targeted. */
  label: string;
}

export interface ScrollOptions {
  /** Bring the element behind this ref into view, or */
  ref?: number;
  /** move the page by this signed amount of pixels. */
  by?: number;
}

export interface KeyOptions {
  key: string;
  /** An optional ref to focus before the key press; default is the active element. */
  ref?: number;
  /**
   * Refused, never sent: this engine accepts the CDP modifier bitmask and still
   * delivers an unmodified key (probe verified on 0.2.2). The field stays so a
   * caller asking for a combo gets a plain refusal instead of a key the page
   * silently sees as plain.
   */
  modifiers?: string[];
}

// AC-2: a ref is resolved against the snapshot taken at the start of the
// action, never against an older read silently. A ref the current snapshot
// does not hold is refused in plain words.
function findFreshRef(ref: number, refs: ReadRef[]): ReadRef {
  const found = refs.find((r) => r.ref === ref);
  if (!found) {
    throw new Error(
      `[${ref}] is not in the latest snapshot; the page changed since the last read or action. ` +
        "Call browser_read for fresh refs.",
    );
  }
  return found;
}

// The fresh snapshot plus the ref it must hold, refused in plain words when the
// page moved on.
export async function freshRef(
  handle: EngineHandle,
  ref: number,
  signal?: AbortSignal,
): Promise<ReadRef> {
  const fresh = await snapshotRefs(handle, signal);
  return findFreshRef(ref, fresh.refs);
}

// The full ref path the element actions and browser_eval's ref form share: the
// fresh snapshot, the ref it must hold, and the object id DOM.resolveNode hands
// to Runtime.callFunctionOn. One place, so the two paths cannot drift apart.
export async function resolveRefTarget(
  handle: EngineHandle,
  ref: number,
  signal?: AbortSignal,
): Promise<{ target: ReadRef; objectId: string }> {
  const target = await freshRef(handle, ref, signal);
  return { target, objectId: await objectForNode(handle, target.node) };
}

// AC-3: fill and type refuse anything that is not a text like input or a
// textarea, naming the element kind.
function assertTextLike(target: ReadRef, action: string): void {
  if (target.kind === "textarea") return;
  const kind = target.kind === "input" ? (target.inputType ?? "text") : target.kind;
  if (target.kind === "input" && TEXT_LIKE_TYPES.has(kind)) return;
  throw new Error(
    `[${target.ref}] is a ${kind}, not a text input; ${action} works on text inputs and textareas.`,
  );
}

// DOM.resolveNode hands a backend node id to Runtime.callFunctionOn, the
// evaluate path every side operation uses.
async function objectForNode(handle: EngineHandle, backendNodeId: number): Promise<string> {
  const resolved = (await send(handle, "DOM.resolveNode", {
    backendNodeId,
  })) as { object?: { objectId?: string } };
  const objectId = resolved?.object?.objectId;
  if (!objectId) {
    throw new Error(
      "the engine could not resolve the element behind the ref; the page may be changing, " +
        "call browser_read for fresh refs",
    );
  }
  return objectId;
}

// Runs a function with the element as `this` and returns its value.
async function callFnOn(
  handle: EngineHandle,
  objectId: string,
  functionDeclaration: string,
  args: unknown[] = [],
): Promise<unknown> {
  const response = (await send(handle, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (response?.exceptionDetails) {
    throw new Error(
      `the page script failed: ${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}`,
    );
  }
  return response?.result?.value;
}

// The box center in layout coordinates: the average of the content quad
// corners (probe fact: boxes are layout coordinates, dispatch wants viewport).
async function boxCenter(
  handle: EngineHandle,
  backendNodeId: number,
): Promise<{ x: number; y: number }> {
  const box = (await send(handle, "DOM.getBoxModel", {
    backendNodeId,
  })) as { model?: { content?: number[]; border?: number[] } };
  const quad = box?.model?.content ?? box?.model?.border;
  if (!quad || quad.length < 8) {
    throw new Error(
      "the element has no visible box; it may be hidden or off the page, call browser_read for fresh refs",
    );
  }
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return {
    x: Math.round((xs[0] + xs[1] + xs[2] + xs[3]) / 4),
    y: Math.round((ys[0] + ys[1] + ys[2] + ys[3]) / 4),
  };
}

async function scrollPosition(handle: EngineHandle): Promise<{ x: number; y: number }> {
  const result = (await send(handle, "Runtime.evaluate", {
    expression: "({ x: window.scrollX || 0, y: window.scrollY || 0 })",
    returnByValue: true,
  })) as { result?: { value?: { x: number; y: number } } };
  return result?.result?.value ?? { x: 0, y: 0 };
}

// AC-1: the element itself or one of its descendants at the center counts as
// clear; anything else is a cover, named by its tag plus its id, aria-label,
// title, or text. Identity is checked with isSameNode and a parent walk: the
// engine hands back a distinct wrapper for the same node across calls, so ===
// and contains do not hold across that boundary (probe verified on 0.2.2).
// ponytail: the cover check rides elementFromPoint, which this engine resolves
// in DOM order rather than stacking order, so a cover that precedes the target
// in the document is not detected; use the engine's own hit test
// (DOM.getNodeForLocation) once it exists.
const COVER_FN = `function (cx, cy) {
  var hit = document.elementFromPoint(cx, cy);
  if (!hit) return { clear: true };
  var node = hit;
  while (node) {
    if (node.isSameNode && node.isSameNode(this)) return { clear: true };
    node = node.parentNode;
  }
  var tag = (hit.tagName || "").toLowerCase();
  var name = "";
  if (hit.id) {
    name = "#" + hit.id;
  } else {
    var label = hit.getAttribute ? (hit.getAttribute("aria-label") || hit.getAttribute("title") || "") : "";
    if (label) {
      name = " " + label;
    } else {
      var t = (hit.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40);
      if (t) name = ": " + t;
    }
  }
  return { clear: false, cover: tag + name };
}`;

// Every action ends the same way (spec 0006): wait for the page to settle,
// wait the quiet delay, take a fresh snapshot, and report where the page is
// and the new scroll position.
async function settledReport(
  handle: EngineHandle,
  signal: AbortSignal | undefined,
): Promise<InteractionReport> {
  await waitForReady(handle, signal);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, QUIET_DELAY_MS);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
  const fresh = await snapshotRefs(handle, signal);
  const pos = await scrollPosition(handle);
  return { refs: fresh.refs, url: fresh.url, title: fresh.title, scrollX: pos.x, scrollY: pos.y };
}

// AC-1 click strand: fresh snapshot, resolve, scroll into view, re fetch the
// box, convert to viewport coordinates, cover check, then a trusted mouse
// press and release at the center.
export async function clickRef(
  handle: EngineHandle,
  ref: number,
  signal?: AbortSignal,
): Promise<ClickReport> {
  return runOp("the click", signal, async () => {
    const { objectId, target } = await resolveRefTarget(handle, ref, signal);
    await callFnOn(handle, objectId, 'function () { this.scrollIntoView({ block: "center" }); }');
    const center = await boxCenter(handle, target.node);
    const scroll = await scrollPosition(handle);
    const viewportX = center.x - scroll.x;
    const viewportY = center.y - scroll.y;
    const verdict = (await callFnOn(handle, objectId, COVER_FN, [viewportX, viewportY])) as {
      clear?: boolean;
      cover?: string;
    };
    if (!verdict?.clear) {
      throw new Error(
        `[${ref}] "${target.text}" is covered at its center by ${verdict?.cover ?? "another element"}; ` +
          "scroll it into view or dismiss the cover first, then click again",
      );
    }
    await send(handle, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: viewportX,
      y: viewportY,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await send(handle, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: viewportX,
      y: viewportY,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    const settled = await settledReport(handle, signal);
    return { label: target.text, ...settled };
  });
}

// AC-3: fill replaces the value. Focus, select everything (the trusted
// insertText that follows replaces the selection), then insert the value.
export async function fillRef(
  handle: EngineHandle,
  ref: number,
  value: string,
  signal?: AbortSignal,
): Promise<InteractionReport> {
  return runOp("the fill", signal, async () => {
    const { target, objectId } = await resolveRefTarget(handle, ref, signal);
    assertTextLike(target, "fill");
    await callFnOn(handle, objectId, "function () { this.focus(); this.select(); }");
    await send(handle, "Input.insertText", { text: value });
    return settledReport(handle, signal);
  });
}

// AC-3: type appends. Focus and move the caret to the end so insertText lands
// after whatever is already there.
export async function typeRef(
  handle: EngineHandle,
  ref: number,
  text: string,
  signal?: AbortSignal,
): Promise<InteractionReport> {
  return runOp("the type", signal, async () => {
    const { target, objectId } = await resolveRefTarget(handle, ref, signal);
    assertTextLike(target, "type");
    await callFnOn(
      handle,
      objectId,
      "function () { this.focus(); var n = this.value ? this.value.length : 0; " +
        "if (this.setSelectionRange) this.setSelectionRange(n, n); }",
    );
    await send(handle, "Input.insertText", { text });
    return settledReport(handle, signal);
  });
}

// AC-5: set a select's value to a named option, matched by label text first
// and then by the value attribute, and fire the change event.
export async function chooseRef(
  handle: EngineHandle,
  ref: number,
  value: string,
  signal?: AbortSignal,
): Promise<InteractionReport> {
  return runOp("the choice", signal, async () => {
    const target = await freshRef(handle, ref, signal);
    if (target.kind !== "select") {
      throw new Error(
        `[${target.ref}] is a ${target.kind}, not a select; choose works on selects.`,
      );
    }
    const options = target.options ?? [];
    const match = options.find((o) => o.label === value) ?? options.find((o) => o.value === value);
    if (!match) {
      const list = options.map((o) => `${o.label} (${o.value})`).join(", ");
      throw new Error(
        `[${target.ref}] has no option "${value}". Valid options: ${list || "none"}.`,
      );
    }
    const objectId = await objectForNode(handle, target.node);
    await callFnOn(
      handle,
      objectId,
      'function (v) { this.value = v; this.dispatchEvent(new Event("change", { bubbles: true })); }',
      [match.value],
    );
    return settledReport(handle, signal);
  });
}

// AC-6: bring a ref into view, or move the page by a signed amount, and report
// the new scroll position.
export async function scrollPage(
  handle: EngineHandle,
  options: ScrollOptions,
  signal?: AbortSignal,
): Promise<InteractionReport> {
  return runOp("the scroll", signal, async () => {
    const hasRef = options.ref !== undefined;
    const hasBy = options.by !== undefined;
    if (hasRef === hasBy) {
      throw new Error(
        hasRef
          ? "pass one of ref or by to browser_scroll, not both"
          : "browser_scroll needs a ref number or a signed amount in pixels (by)",
      );
    }
    if (hasRef) {
      const { objectId } = await resolveRefTarget(handle, options.ref as number, signal);
      await callFnOn(handle, objectId, 'function () { this.scrollIntoView({ block: "center" }); }');
    } else {
      await send(handle, "Runtime.evaluate", {
        expression: `window.scrollBy(0, ${options.by as number})`,
        returnByValue: true,
      });
    }
    return settledReport(handle, signal);
  });
}

// AC-4: a named key or a single character, sent with trusted events to the
// active element (or to the element an optional ref focuses first). Enter on a
// focused submit control submits natively. A modifier combo is refused rather
// than sent: this engine drops modifier state (probe verified on 0.2.2), so the
// combo would look like it worked while the page saw a plain key.
export async function keyPress(
  handle: EngineHandle,
  options: KeyOptions,
  signal?: AbortSignal,
): Promise<InteractionReport> {
  return runOp("the key press", signal, async () => {
    const requested = (options.modifiers ?? []).filter((m) => m.trim().length > 0);
    if (requested.length > 0) {
      throw new Error(
        `modifier combos are not available: this engine drops modifier state, so ` +
          `${requested.join("+")} plus ${options.key} would reach the page as a plain key. ` +
          "Press the key on its own, or use the page's own affordance for the shortcut.",
      );
    }
    if (options.ref !== undefined) {
      const { objectId } = await resolveRefTarget(handle, options.ref, signal);
      await callFnOn(handle, objectId, "function () { this.focus(); }");
    }
    const keyInfo = resolveKey(options.key);
    // The text goes on the char event only: this engine inserts text carried on
    // keyDown as well, so sending it in both places types the character twice
    // (probe verified with scratch/probe-keytext.ts).
    const { text, ...keyEvent } = keyInfo;
    await send(handle, "Input.dispatchKeyEvent", { type: "keyDown", ...keyEvent });
    if (text) {
      await send(handle, "Input.dispatchKeyEvent", { type: "char", text });
    }
    await send(handle, "Input.dispatchKeyEvent", { type: "keyUp", ...keyEvent });
    return settledReport(handle, signal);
  });
}

interface KeyInfo {
  key: string;
  /** The DOM code and virtual key code, where the named map knows them. */
  code?: string;
  windowsVirtualKeyCode?: number;
  /** The text a plain (unmodified) key produces, sent as a char event. */
  text?: string;
}

// The named key map, then any single character; anything else is refused with
// the valid names listed.
function resolveKey(raw: string): KeyInfo {
  const name = raw.trim();
  const named = KEY_MAP[name.toLowerCase()];
  if (named) return named;
  if (/^[a-z]$/i.test(name)) {
    const upper = name.toUpperCase();
    return {
      key: upper,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      text: upper,
    };
  }
  if (/^[0-9]$/.test(name)) {
    return {
      key: name,
      code: `Digit${name}`,
      windowsVirtualKeyCode: name.charCodeAt(0),
      text: name,
    };
  }
  if (name.length === 1) {
    // A single character the map does not name (punctuation, a symbol): the
    // engine takes the key and the char text, and the code is left out because
    // this map has no verified code for it.
    return { key: name, text: name };
  }
  throw new Error(
    `unknown key "${raw}". Use a named key (Enter, Tab, Escape, Backspace, Delete, Home, End, ` +
      "PageUp, PageDown, ArrowUp, ArrowDown, ArrowLeft, ArrowRight) or a single character.",
  );
}
