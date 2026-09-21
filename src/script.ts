// src/script.ts
// The script and wait tools (slice 3, feature 8, spec 0007): browser_eval runs
// the caller's own JavaScript in the page, and browser_wait polls until text,
// an element, or a condition appears. These are the only two tools that run
// caller authored JavaScript, so they carry the engine's real limits, all probe
// verified on obscura 0.2.2 (the spec 0007 rationale probe record): an awaited
// promise is bounded at 30 seconds by the engine itself and no other evaluation
// is answered during that bound; a `while (true) {}` page loop wedges the
// engine for good, which is why a timeout with an evaluation still outstanding
// is raised as an engine death (AC-12); the engine's innerText equals its
// textContent, so a text match is text anywhere in the document and no
// visibility claim is offered; and a malformed selector returns null rather
// than throwing, so a mistyped selector reads as no match.
//
// Both run through runOp inside the supervisor queue: the queue gives them the
// 30 second clock, the caller's abort signal, and the plain error categories,
// and the wait holds the queue for its whole poll, so no other browser call
// interleaves (AC-10).

import type { ReadRef } from "./browser.js";
import {
  alreadyClassified,
  CANCELLED_MESSAGE,
  pageInfo,
  runOp,
  send,
  snapshotRefs,
  TOOL_TIMEOUT_MS,
} from "./browser.js";
import { findFreshRef, objectForNode } from "./interact.js";
import { type EngineHandle, isConnectionDead } from "./supervisor.js";

// spec 0007: the eval result cap, in characters of the serialized value.
const EVAL_RESULT_CAP = 20_000;

// spec 0007 AC-7: the wait's own clock, the range it is clamped to, its poll
// interval, and the reserve the final snapshot, the page info read, and the
// queue release share inside the tool clock.
const WAIT_DEFAULT_MS = 10_000;
const WAIT_MIN_MS = 500;
const WAIT_MAX_MS = 25_000;
const WAIT_POLL_MS = 100;
const WAIT_RESERVE_MS = 5_000;

// AC-11: a tick that failed for a reason that is not the page's own fault (a
// page navigating under the poll, for example) is retried this many times in a
// row before the wait gives up in plain words.
const MAX_FAILED_TICKS = 3;

// AC-4: the engine reports a page error on the Runtime.evaluate path in the
// response's exception details, and the message every page error is raised
// with, so the tick loop can tell a page error from a transport one.
const PAGE_ERROR_PREFIX = "the page's own script threw:";

const ELEMENT_NOTE =
  "The expression returned a DOM element. This engine serialises an element into a large object " +
  "of computed styles, so the value is not printed. Return a property of the element instead, " +
  "for example `return this.textContent`.";
const EMPTY_OBJECT_NOTE =
  "The value reads as an empty object, which is what this engine returns for a Promise, a Map, " +
  "and a Set alike, so it may be one of those rather than a genuinely empty object. If the " +
  "expression returns a promise, run it again with await: true.";
const NULL_NOTE =
  "This engine reports undefined, null, and NaN with the same shape, so the value is one of those three.";

export interface EvalOptions {
  /** The JavaScript to run. */
  expression: string;
  /** Run the expression as the body of a function with this element as `this`. */
  ref?: number;
  /** Await a promise result, bounded by the engine's own 30 second bound. */
  await?: boolean;
}

export interface EvalReport {
  /** The serialized value, capped, or a plain placeholder for a degraded value. */
  value: string;
  /** The JavaScript type the engine reported, with its class name where it has one. */
  type: string;
  truncated: boolean;
  /** One plain sentence about a degraded value, the ambiguity, or the truncation. */
  note?: string;
  /** The ref the expression ran against, when one was given. */
  ref?: number;
  url: string;
  title: string;
}

/** The result payload shape this engine returns for both evaluator paths. */
interface EvalPayload {
  type?: string;
  subtype?: string | null;
  className?: string;
  description?: string;
  value?: unknown;
}

interface EvalResponse {
  result?: EvalPayload;
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

export type WaitMode = "text" | "selector" | "condition";

export interface WaitOptions {
  /** Wait for this literal, case sensitive substring of the page's text. */
  text?: string;
  /** Wait for a CSS selector that matches an element. */
  selector?: string;
  /** Wait for the caller's own JavaScript expression to have a truthy completion value. */
  condition?: string;
  /** How long to wait; defaults to 10000 and is clamped to 500 to 25000. */
  timeoutMs?: number;
}

export interface WaitReport {
  appeared: boolean;
  mode: WaitMode;
  /** The literal, selector, or expression that was watched. */
  watched: string;
  elapsedMs: number;
  /** The clamp note and the selector caveat, when either applies. */
  notes: string[];
  refs: ReadRef[];
  url: string;
  title: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// AC-4: the page's own message plus its first stack frame, from either shape
// the engine uses.
function pageErrorText(raw: string): string {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const message = lines[0] ?? "it threw without a message";
  const frame = lines.find((line) => line.startsWith("at "));
  return frame ? `${message} (${frame})` : message;
}

// AC-1: the value text. The engine's degradations are named here rather than
// printed: a DOM element arrives as an object carrying `_nid`, and a Promise,
// a Map, and a Set all arrive as an empty object.
function describeValue(payload: EvalPayload): {
  value: string;
  type: string;
  truncated: boolean;
  note?: string;
} {
  const raw = payload.value;
  const type = describeType(payload);

  if (isRecord(raw) && "_nid" in raw) {
    return { value: "(a DOM element)", type, truncated: false, note: ELEMENT_NOTE };
  }
  if (payload.type === "object" && !payload.subtype && isRecord(raw)) {
    const keys = Object.keys(raw);
    if (keys.length === 0) {
      return { value: "{}", type, truncated: false, note: EMPTY_OBJECT_NOTE };
    }
  }
  if (raw === null || raw === undefined) {
    return { value: "null", type, truncated: false, note: NULL_NOTE };
  }

  const text = safeJson(raw);
  if (text.length > EVAL_RESULT_CAP) {
    return {
      value: text.slice(0, EVAL_RESULT_CAP),
      type,
      truncated: true,
      note: `The value is ${text.length} characters; the first ${EVAL_RESULT_CAP} are shown.`,
    };
  }
  return { value: text, type, truncated: false };
}

// AC-1: the type label comes from the payload's own type, subtype, and class
// name. The class name is only worth printing when it says more than the type
// (a plain object and an element both report "Object" here).
function describeType(payload: EvalPayload): string {
  if (payload.subtype === "array") return "array";
  if (payload.className && payload.className !== "Object") {
    return `${payload.type ?? "unknown"} ${payload.className}`;
  }
  return payload.type ?? "unknown";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// AC-4: a page error reaches the ref path as a CDP protocol error of the form
// `JS error: <page message>`, never as exception details (probe verified).
function protocolPageError(error: unknown): string | undefined {
  const match = /JS error:\s*([\s\S]*)$/.exec(errorText(error));
  return match ? pageErrorText(match[1]) : undefined;
}

function pageError(details: { text?: string; exception?: { description?: string } }): Error {
  return new Error(
    `${PAGE_ERROR_PREFIX} ${pageErrorText(
      details.exception?.description ?? details.text ?? "it threw without a message",
    )}`,
  );
}

// Runs the expression once and returns the engine's result payload: on the
// script path through Runtime.evaluate, and with a ref through a fresh
// snapshot, DOM.resolveNode, and Runtime.callFunctionOn with the element as
// `this` (AC-2). The await flag goes to the engine on both paths (AC-3).
async function evaluateOnce(
  handle: EngineHandle,
  options: EvalOptions,
  signal: AbortSignal | undefined,
): Promise<EvalPayload> {
  const awaitPromise = options.await === true;
  if (options.ref === undefined) {
    const response = (await send(handle, "Runtime.evaluate", {
      expression: options.expression,
      returnByValue: true,
      awaitPromise,
    })) as EvalResponse;
    if (response?.exceptionDetails) throw pageError(response.exceptionDetails);
    return response?.result ?? {};
  }

  const fresh = await snapshotRefs(handle, signal);
  const target = findFreshRef(options.ref, fresh.refs);
  const objectId = await objectForNode(handle, target.node);
  try {
    const response = (await send(handle, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {\n${options.expression}\n}`,
      returnByValue: true,
      awaitPromise,
    })) as EvalResponse;
    if (response?.exceptionDetails) throw pageError(response.exceptionDetails);
    return response?.result ?? {};
  } catch (error) {
    const fromProtocol = protocolPageError(error);
    if (fromProtocol) throw new Error(`${PAGE_ERROR_PREFIX} ${fromProtocol}`);
    throw error;
  }
}

const PROMISE_BOUND_MESSAGE =
  "The promise did not settle within the engine's own 30 second bound, which is the same length " +
  "as this tool's clock, so the engine stopped waiting for it. The session is still usable; call " +
  "again, or use browser_wait for content that appears later.";

// AC-12: the one error a tool raises itself, when the clock expired with a page
// evaluation still outstanding. It is already plain and already carries the
// engine death verdict, so the error mapper passes it through and the queue
// acts on it. Nothing outside the page can stop page JavaScript, which is why a
// still running evaluation means a fresh engine on the next call.
function hangingScriptError(): Error {
  return alreadyClassified(
    new Error(
      `The page script was still running when the tool clock expired after ${
        TOOL_TIMEOUT_MS / 1000
      } seconds, so the engine is treated as down: the next browser call starts a fresh engine and ` +
        "the page state is gone. The page script may still be running, because an endless loop in a " +
        "page script cannot be stopped from outside; keep a page loop short or split it up.",
    ),
    true,
  );
}

// A page error whose own text happens to contain a clock phrase must never be
// read as a timeout: the outstanding flag is only true while an evaluation is
// genuinely in flight, and this guard keeps that reading honest.
function timedOutAtTheClock(error: unknown): boolean {
  return /timed out|did not settle within/i.test(errorText(error));
}

// AC-1, AC-2, AC-3, AC-4: run the caller's JavaScript and report the value with
// its type, or fail in plain words on a page error, a stale ref, an unsettled
// promise, or a page script that outlives the tool clock (AC-12).
export async function evalInPage(
  handle: EngineHandle,
  options: EvalOptions,
  signal?: AbortSignal,
): Promise<EvalReport> {
  const awaiting = options.await === true;
  const what = options.ref === undefined ? "the script evaluation" : "the element script";
  // AC-12: whether a page evaluation was still outstanding when the clock
  // expired. The finally only runs once the evaluation came back, so a page
  // script that never returns leaves this true.
  let outstanding = false;

  try {
    const result = await runOp(what, signal, async () => {
      outstanding = true;
      try {
        const payload = await evaluateOnce(handle, options, signal);
        // AC-11: the page read belongs to the same call, so it runs inside the
        // same clock and abort race. Left outside, a page that wedges after
        // returning its value would hang this call with nothing to bound it.
        const info = await pageInfo(handle);
        return { payload, info };
      } catch (error) {
        // The engine raises its own bound on an awaited promise; report it in
        // plain words rather than as a raw protocol message.
        if (awaiting && /did not settle within/i.test(errorText(error))) {
          throw alreadyClassified(new Error(PROMISE_BOUND_MESSAGE));
        }
        throw error;
      } finally {
        outstanding = false;
      }
    });
    const described = describeValue(result.payload);
    return {
      ...described,
      ref: options.ref,
      url: result.info.href,
      title: result.info.title,
    };
  } catch (error) {
    if (!outstanding || !timedOutAtTheClock(error)) throw error;
    // AC-3: an awaited call is exempt, because the engine's own 30 second bound
    // is exactly this case and the session recovers by itself; it raises no
    // death verdict.
    if (awaiting) throw alreadyClassified(new Error(PROMISE_BOUND_MESSAGE));
    // AC-12: an evaluation still outstanding at the clock means the engine is
    // treated as down and the next browser call starts a fresh one.
    throw hangingScriptError();
  }
}

// AC-5: exactly one of text, selector, or condition, refused in plain words
// otherwise, the same rule browser_scroll already uses for ref and by.
function resolveMode(options: WaitOptions): { mode: WaitMode; watched: string } {
  const given: Array<[WaitMode, string]> = [];
  if (options.text !== undefined) given.push(["text", options.text]);
  if (options.selector !== undefined) given.push(["selector", options.selector]);
  if (options.condition !== undefined) given.push(["condition", options.condition]);

  if (given.length === 0) {
    throw new Error(
      "browser_wait needs one of text, selector, or condition; none of them was passed.",
    );
  }
  if (given.length > 1) {
    throw new Error(
      `pass exactly one of text, selector, or condition to browser_wait, not ${given
        .map(([mode]) => mode)
        .join(" and ")}.`,
    );
  }
  return { mode: given[0][0], watched: given[0][1] };
}

// AC-7: the wait's own clock, clamped into the code constant range with a note
// naming the clamp.
function resolveTimeout(requested: number | undefined): { timeoutMs: number; notes: string[] } {
  if (requested === undefined) return { timeoutMs: WAIT_DEFAULT_MS, notes: [] };
  if (!Number.isFinite(requested)) {
    return {
      timeoutMs: WAIT_DEFAULT_MS,
      notes: [
        `timeoutMs was not a number of milliseconds; the ${WAIT_DEFAULT_MS} ms default is in use.`,
      ],
    };
  }
  const timeoutMs = Math.min(Math.max(requested, WAIT_MIN_MS), WAIT_MAX_MS);
  if (timeoutMs === requested) return { timeoutMs, notes: [] };
  return {
    timeoutMs,
    notes: [
      `timeoutMs ${requested} is outside ${WAIT_MIN_MS} to ${WAIT_MAX_MS} ms; the wait used ${timeoutMs} ms.`,
    ],
  };
}

// AC-6: the text and selector polls are plugin owned constant expressions; the
// condition poll is the caller's own expression.
function pollExpression(mode: WaitMode, watched: string): string {
  if (mode === "text") return `document.body.innerText.indexOf(${JSON.stringify(watched)}) >= 0`;
  if (mode === "selector") return `document.querySelector(${JSON.stringify(watched)}) !== null`;
  return watched;
}

// One poll: a page error is raised with the private prefix so the tick loop
// never reads it as a transport failure, and every other failure propagates
// raw for the loop to classify.
async function pollOnce(handle: EngineHandle, expression: string): Promise<boolean> {
  const response = (await send(handle, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: false,
  })) as EvalResponse;
  if (response?.exceptionDetails) throw pageError(response.exceptionDetails);
  return Boolean(response?.result?.value);
}

// Races the tick interval against the caller's abort signal, so an aborted wait
// stops at once instead of finishing its interval (AC-10).
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

// AC-5 to AC-11: poll exactly one mode every 100 ms until it matches or the
// deadline passes, then report the verdict with fresh refs on both paths. A
// wait that runs out of time is a normal result, never an error.
export async function waitForMatch(
  handle: EngineHandle,
  options: WaitOptions,
  signal?: AbortSignal,
): Promise<WaitReport> {
  const { mode, watched } = resolveMode(options);
  const { timeoutMs, notes } = resolveTimeout(options.timeoutMs);
  const expression = pollExpression(mode, watched);
  const started = Date.now();
  // AC-7: the poll loop stops at the smaller of the wait's own clock and the
  // tool clock minus the reserve, so the final snapshot and the queue release
  // still fit inside the tool clock.
  const deadline = started + Math.min(timeoutMs, TOOL_TIMEOUT_MS - WAIT_RESERVE_MS);

  let appeared = false;
  let failedTicks = 0;
  let lastFailure = "";
  // AC-12: whether a page evaluation was still outstanding when the tool clock
  // expired. A tick and the final snapshot both run through tracked, whose
  // finally clears the flag only once the call came back, so a poll the page
  // never returns from leaves it true and the engine is treated as down.
  let outstanding = false;
  const tracked = async <T>(body: () => Promise<T>): Promise<T> => {
    outstanding = true;
    try {
      return await body();
    } finally {
      outstanding = false;
    }
  };

  try {
    return await runOp("the wait", signal, async () => {
      while (true) {
        if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
        try {
          appeared = await tracked(() => pollOnce(handle, expression));
          failedTicks = 0;
        } catch (error) {
          const detail = errorText(error);
          // A page error is the caller's own expression and is refused at once,
          // and a dead engine is never retried (AC-11).
          if (detail.startsWith(PAGE_ERROR_PREFIX) || isConnectionDead(detail)) throw error;
          failedTicks += 1;
          lastFailure = detail;
          if (failedTicks >= MAX_FAILED_TICKS) {
            throw new Error(
              `the wait could not read the page ${MAX_FAILED_TICKS} times in a row: ${lastFailure}. ` +
                "The page may be navigating or mid change; call browser_read to see where it is.",
            );
          }
        }
        if (appeared) break;
        if (Date.now() >= deadline) break;
        await sleep(WAIT_POLL_MS, signal);
      }

      const elapsedMs = Date.now() - started;
      const fresh = await tracked(() => snapshotRefs(handle, signal));
      const finalNotes = [...notes];
      if (!appeared && mode === "selector") {
        finalNotes.push(
          `This engine returns null for a selector it cannot parse, so a mistyped selector reads as ` +
            `no match. Check the selector: ${watched}`,
        );
      }
      return {
        appeared,
        mode,
        watched,
        elapsedMs,
        notes: finalNotes,
        refs: fresh.refs,
        url: fresh.url,
        title: fresh.title,
      };
    });
  } catch (error) {
    // AC-12: a page evaluation still outstanding at the clock means the engine
    // is treated as down and the next browser call starts a fresh one. A wait
    // never awaits a promise, so no case here is exempt.
    if (!outstanding || !timedOutAtTheClock(error)) throw error;
    throw hangingScriptError();
  }
}
