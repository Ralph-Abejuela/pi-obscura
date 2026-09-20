// src/browser.ts
// The browser operations behind the navigation and reading tools (slice 1,
// feature 6). Every operation runs inside the supervisor queue, against the
// single session page the supervisor attaches at spawn, and is bounded by the
// caller's abort signal and a 30 second tool timeout (spec 0001). Reading
// takes a CDP DOM snapshot and serializes it to markdown, numbering only the
// interactive elements (links, buttons, inputs, selects, textareas) in
// document order, each mapped to its CDP backend node ID for the interaction
// tools that land in slice 2.
//
// Engine behavior was verified live against obscura 0.2.2: the page session
// is created via Target.createTarget; history traversal goes through
// Page.getNavigationHistory + Page.navigateToHistoryEntry (Page.goBack and
// Page.goForward do not exist, and history.back() from Runtime.evaluate is a
// no-op); DOMSnapshot.captureSnapshot returns one shared `strings` array and
// a flat nodes array keyed by parentIndex (no childNodeIndexes); and the
// engine refuses private or loopback addresses with a plain error.

import type { EngineHandle } from "./supervisor.js";

const TOOL_TIMEOUT_MS = 30_000; // spec 0001: default tool timeout
const READY_POLL_MS = 200;
const MAX_MARKDOWN_CHARS = 60_000;
const CANCELLED_MESSAGE = "the browser call was cancelled";

export interface NavReport {
  url: string;
  title: string;
  frameId?: string;
}

export interface ReadRef {
  ref: number;
  node: number; // CDP backend node ID
  kind: "link" | "button" | "input" | "select" | "textarea";
  text: string;
  href?: string;
}

export interface ReadReport {
  markdown: string;
  url: string;
  title: string;
  refs: ReadRef[];
  truncated: boolean;
}

// A raw protocol send; the engine's actual coverage is the thing under test,
// so we send by method name (same cast engine.ts and supervisor.ts explain).
type SendRaw = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;

async function send(
  handle: EngineHandle,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  // SAFETY: the library's send is overloaded on a fixed protocol mapping, but we
  // send by raw method name because the engine's coverage is the thing under
  // test (same cast engine.ts and supervisor.ts document). The cast only
  // relaxes parameter types; behavior is unchanged.
  const sendRaw = handle.client.send.bind(handle.client) as unknown as SendRaw;
  return sendRaw(method, params ?? {}, handle.sessionId);
}

function raceSignal(signal?: AbortSignal): Promise<never> | null {
  if (!signal) return null;
  if (signal.aborted) return Promise.reject(new Error(CANCELLED_MESSAGE));
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error(CANCELLED_MESSAGE)), { once: true });
  });
}

// Bounds one operation against the tool timeout and the caller's abort.
async function bounded<T>(signal: AbortSignal | undefined, body: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the browser call timed out after ${TOOL_TIMEOUT_MS} ms`)),
      TOOL_TIMEOUT_MS,
    );
  });
  try {
    const rivals: Promise<unknown>[] = [body(), timeout];
    const abort = raceSignal(signal);
    if (abort) rivals.push(abort);
    return (await Promise.race(rivals)) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Spec 0001: one small mapper turns CDP and connection errors into plain
// messages with a next step. Engine down and page errors already carry plain
// text from the supervisor and the engine; this adds the timeout and the
// protocol-unsupported categories on top.
export function classifyError(error: unknown, what: string): Error {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail === CANCELLED_MESSAGE) return new Error(CANCELLED_MESSAGE);
  if (/timed out after/i.test(detail)) {
    return new Error(
      `${what} timed out. The page may still be loading or a resource hung; try the call again or read the page directly.`,
    );
  }
  if (/unknown .*method|method not found|not implemented|not supported/i.test(detail)) {
    return new Error(
      `The engine does not implement the protocol method needed for ${what} (${detail}). ` +
        "If an essential tool depends on it, this needs an architecture reconsideration.",
    );
  }
  if (
    /connection closed|socket|websocket|disconnect|no page for session|target.*closed/i.test(detail)
  ) {
    return new Error(
      `The engine died while ${what} was in flight; the page state is gone. The next browser call starts a fresh engine.`,
    );
  }
  return new Error(`${what} failed: ${detail}`);
}

async function runOp<T>(
  what: string,
  signal: AbortSignal | undefined,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await bounded(signal, body);
  } catch (error) {
    throw classifyError(error, what);
  }
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    throw new Error(
      `"${raw}" is not a full URL. Include the scheme, for example https://example.com.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`"${raw}" is not a valid URL. Pass one like https://example.com/about.`);
  }
  const allowed = new Set(["http:", "https:", "data:", "file:", "about:"]);
  if (!allowed.has(parsed.protocol)) {
    throw new Error(
      `The browser opens http(s), data, file, and about pages; "${parsed.protocol}" is not one of them.`,
    );
  }
  return parsed.href;
}

interface PageInfo {
  href: string;
  title: string;
}

async function pageInfo(handle: EngineHandle): Promise<PageInfo> {
  const result = (await send(handle, "Runtime.evaluate", {
    expression: "({ href: location.href, title: document.title })",
    returnByValue: true,
  })) as { result?: { value?: PageInfo } };
  const value = result?.result?.value;
  return value && typeof value.href === "string" ? value : { href: "about:blank", title: "" };
}

// Polls document.readyState until the page finishes loading, then reports the
// current URL and title. Navigation on this engine never hangs the call: the
// poll gives up at the tool timeout with a plain message.
async function waitForReady(
  handle: EngineHandle,
  signal: AbortSignal | undefined,
): Promise<PageInfo> {
  const deadline = Date.now() + TOOL_TIMEOUT_MS;
  while (true) {
    if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
    const ready = (await send(handle, "Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    })) as { result?: { value?: string } };
    if (ready?.result?.value === "complete") return pageInfo(handle);
    if (Date.now() >= deadline) {
      throw new Error(
        `the page did not finish loading within ${TOOL_TIMEOUT_MS / 1000} seconds; it may still be rendering. ` +
          "Call browser_read to see what is there.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
}

export async function navigate(
  handle: EngineHandle,
  rawUrl: string,
  signal?: AbortSignal,
): Promise<NavReport> {
  return runOp("the navigation", signal, async () => {
    const url = normalizeUrl(rawUrl);
    const response = (await send(handle, "Page.navigate", { url })) as {
      frameId?: string;
      errorText?: string;
    };
    if (response?.errorText) {
      throw new Error(
        `the page could not be opened (${response.errorText}). Check the URL and try again.`,
      );
    }
    const info = await waitForReady(handle, signal);
    return { url: info.href, title: info.title, frameId: response?.frameId };
  });
}

export async function reloadPage(handle: EngineHandle, signal?: AbortSignal): Promise<NavReport> {
  return runOp("the reload", signal, async () => {
    await send(handle, "Page.reload", { ignoreCache: false });
    const info = await waitForReady(handle, signal);
    return { url: info.href, title: info.title };
  });
}

// Back and forward use the engine's own history entries (Page.goBack and
// Page.goForward do not exist on this engine; its internal traversal via
// Page.navigateToHistoryEntry is verified live).
export async function goBack(handle: EngineHandle, signal?: AbortSignal): Promise<NavReport> {
  return historyStep(handle, "back", signal);
}

export async function goForward(handle: EngineHandle, signal?: AbortSignal): Promise<NavReport> {
  return historyStep(handle, "forward", signal);
}

async function historyStep(
  handle: EngineHandle,
  direction: "back" | "forward",
  signal?: AbortSignal,
): Promise<NavReport> {
  const what = direction === "back" ? "going back" : "going forward";
  return runOp(what, signal, async () => {
    const history = (await send(handle, "Page.getNavigationHistory")) as {
      currentIndex?: number;
      entries?: Array<{ id: number; url?: string }>;
    };
    const entries = history?.entries ?? [];
    const current = history?.currentIndex ?? 0;
    const target = direction === "back" ? current - 1 : current + 1;
    if (target < 0) {
      throw new Error("there is no earlier page to go back to; this session has not navigated yet");
    }
    if (target >= entries.length) {
      throw new Error(
        "there is no later page to go forward to; this is the newest page of the session",
      );
    }
    await send(handle, "Page.navigateToHistoryEntry", { entryId: entries[target].id });
    const info = await waitForReady(handle, signal);
    return { url: info.href, title: info.title };
  });
}

// --- reading: DOMSnapshot to markdown -------------------------------------

// Structural snapshot types, kept loose because the engine's exact coverage
// is the thing under test (spec 0001 capability probe).
interface SnapshotNodes {
  parentIndex: number[];
  nodeType: number[];
  nodeName: number[];
  nodeValue: number[];
  backendNodeId: number[];
  attributes: number[][];
  isClickable?: boolean[];
}

interface SnapshotDocument {
  title?: number;
  documentURL?: number;
  nodes?: SnapshotNodes;
}

interface SnapshotResult {
  documents?: SnapshotDocument[];
  strings?: string[];
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const COMMENT_NODE = 8;

// Subtree skipped whole (noise or content the engine renders outside our
// main frame; iframes are the deferred tabs surface, slice 1 reads the main
// frame only. ponytail: iframe content is dropped, add per frame reads if a
// page's real content lives in one).
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "HEAD",
  "META",
  "LINK",
  "BASE",
  "TITLE",
  "IFRAME",
]);

const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "SECTION",
  "ARTICLE",
  "HEADER",
  "FOOTER",
  "MAIN",
  "NAV",
  "ASIDE",
  "UL",
  "OL",
  "TABLE",
  "THEAD",
  "TBODY",
  "TFOOT",
  "BLOCKQUOTE",
  "PRE",
  "HR",
  "FORM",
  "FIELDSET",
  "DETAILS",
  "ADDRESS",
]);

const HEADING_LEVEL: Record<string, number> = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };

interface WalkContext {
  out: string;
  refs: ReadRef[];
  refCount: number;
  truncated: boolean;
}

function attrMap(nodes: SnapshotNodes, index: number, strings: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const pairs = nodes.attributes?.[index];
  if (pairs) {
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const name = strings[pairs[i]] ?? "";
      if (!name) continue;
      const value = strings[pairs[i + 1]] ?? "";
      const low = name.toLowerCase();
      map.set(low, low === "href" || low === "src" ? value.replace(/\s+/g, " ").trim() : value);
    }
  }
  return map;
}

// The flattened text under a node, used for headings, links, and the labels
// of interactive elements.
// ponytail: subtreeText scans the node array for children per node, quadratic
// on very large subtrees; fine while it is used only for small labels.
function subtreeText(nodes: SnapshotNodes, strings: string[], index: number): string {
  const parts: string[] = [];
  // Push reversed so pops visit children in document order (same as the walk).
  const stack: number[] = [];
  const kids = childrenOf(nodes, index);
  for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
  while (stack.length > 0) {
    const i = stack.pop() as number;
    if (nodes.nodeType[i] === TEXT_NODE) {
      const value = strings[nodes.nodeValue[i]] ?? "";
      const clean = value.replace(/\s+/g, " ").trim();
      if (clean) parts.push(clean);
    } else {
      const nested = childrenOf(nodes, i);
      for (let k = nested.length - 1; k >= 0; k--) stack.push(nested[k]);
    }
  }
  return parts.join(" ");
}

// This engine's snapshot has no childNodeIndexes; the flat nodes array plus
// parentIndex reconstructs the tree (verified live on 0.2.2).
function childrenOf(nodes: SnapshotNodes, index: number): number[] {
  const kids: number[] = [];
  for (let i = 0; i < nodes.nodeType.length; i++) {
    if (nodes.parentIndex[i] === index) kids.push(i);
  }
  return kids;
}

function appendRaw(ctx: WalkContext, s: string): void {
  if (ctx.truncated || !s) return;
  ctx.out += s;
  if (ctx.out.length > MAX_MARKDOWN_CHARS) {
    ctx.out = ctx.out.slice(0, MAX_MARKDOWN_CHARS);
    ctx.truncated = true;
  }
}

function ensureNewline(ctx: WalkContext): void {
  if (ctx.out && !ctx.out.endsWith("\n")) appendRaw(ctx, "\n");
}

function blankLine(ctx: WalkContext): void {
  ensureNewline(ctx);
  if (ctx.out && !ctx.out.endsWith("\n\n")) appendRaw(ctx, "\n");
}

// Inline text with a single space between segments on the same line.
function appendInline(ctx: WalkContext, s: string): void {
  const clean = s.replace(/\s+/g, " ").trim();
  if (!clean) return;
  if (ctx.out && !ctx.out.endsWith("\n") && !ctx.out.endsWith(" ")) appendRaw(ctx, " ");
  appendRaw(ctx, clean);
}

function readAttr(attrs: Map<string, string>, name: string): string | undefined {
  const value = attrs.get(name);
  return value && value.length > 0 ? value : undefined;
}

function addRef(ctx: WalkContext, nodes: SnapshotNodes, index: number, ref: ReadRef): void {
  ref.ref = ++ctx.refCount;
  ref.node = nodes.backendNodeId?.[index] ?? -1;
  ref.text = ref.text.replace(/\s+/g, " ").trim() || ref.kind;
  ctx.refs.push(ref);
}

function serialize(nodes: SnapshotNodes, strings: string[]): WalkContext {
  const ctx: WalkContext = { out: "", refs: [], refCount: 0, truncated: false };
  const stack = [0]; // node 0 is the #document root
  while (stack.length > 0 && !ctx.truncated) {
    const index = stack.pop() as number;
    const nodeType = nodes.nodeType?.[index];
    if (nodeType === COMMENT_NODE) continue;
    const nodeName = (strings[nodes.nodeName?.[index]] ?? "").toUpperCase();
    const kids = childrenOf(nodes, index);

    if (nodeType === TEXT_NODE) {
      appendInline(ctx, strings[nodes.nodeValue?.[index]] ?? "");
      continue;
    }
    if (nodeType !== ELEMENT_NODE) {
      // #document (and any unknown node kind) just descends into its children.
      for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
      continue;
    }
    if (SKIP_TAGS.has(nodeName)) continue;

    const attrs = attrMap(nodes, index, strings);
    const heading = HEADING_LEVEL[nodeName];

    if (heading) {
      blankLine(ctx);
      appendRaw(ctx, `${"#".repeat(heading)} `);
      appendInline(ctx, subtreeText(nodes, strings, index));
      blankLine(ctx);
      continue;
    }
    if (nodeName === "A") {
      const href = readAttr(attrs, "href");
      if (href) {
        const text = subtreeText(nodes, strings, index) || href;
        addRef(ctx, nodes, index, {
          ref: 0,
          node: 0,
          kind: "link",
          text,
          href,
        });
        appendInline(ctx, `[${text}](${href})`);
      } else {
        appendInline(ctx, subtreeText(nodes, strings, index));
      }
      continue;
    }
    if (nodeName === "BUTTON") {
      const text = subtreeText(nodes, strings, index) || readAttr(attrs, "value") || "button";
      addRef(ctx, nodes, index, { ref: 0, node: 0, kind: "button", text });
      appendInline(ctx, `[${ctx.refCount}] button "${text}"`);
      continue;
    }
    if (nodeName === "INPUT") {
      const type = (readAttr(attrs, "type") ?? "text").toLowerCase();
      if (type === "hidden") continue;
      const label = readAttr(attrs, "placeholder") || readAttr(attrs, "value") || `${type} input`;
      addRef(ctx, nodes, index, { ref: 0, node: 0, kind: "input", text: label });
      appendInline(ctx, `[${ctx.refCount}] ${label}`);
      continue;
    }
    if (nodeName === "SELECT") {
      const text = subtreeText(nodes, strings, index) || "select";
      addRef(ctx, nodes, index, { ref: 0, node: 0, kind: "select", text: `select (${text})` });
      appendInline(ctx, `[${ctx.refCount}] select (${text})`);
      continue;
    }
    if (nodeName === "TEXTAREA") {
      const text =
        subtreeText(nodes, strings, index) || readAttr(attrs, "placeholder") || "textarea";
      addRef(ctx, nodes, index, { ref: 0, node: 0, kind: "textarea", text });
      appendInline(ctx, `[${ctx.refCount}] textarea "${text}"`);
      continue;
    }
    if (nodeName === "IMG") {
      const alt = readAttr(attrs, "alt") ?? "";
      const src = readAttr(attrs, "src") ?? "";
      appendInline(ctx, src ? `![${alt}](${src})` : alt || "[image]");
      continue;
    }
    if (nodeName === "BR") {
      ensureNewline(ctx);
      continue;
    }
    if (nodeName === "HR") {
      blankLine(ctx);
      appendRaw(ctx, "---");
      blankLine(ctx);
      continue;
    }
    if (nodeName === "LI") {
      ensureNewline(ctx);
      appendRaw(ctx, "- ");
    } else if (BLOCK_TAGS.has(nodeName)) {
      ensureNewline(ctx);
    }

    for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
  }
  return ctx;
}

export async function readPage(handle: EngineHandle, signal?: AbortSignal): Promise<ReadReport> {
  return runOp("the page read", signal, async () => {
    const snap = (await send(handle, "DOMSnapshot.captureSnapshot", {
      computedStyles: [],
    })) as SnapshotResult;
    const document = snap?.documents?.[0];
    const nodes = document?.nodes;
    const strings = snap?.strings ?? [];
    if (!nodes || nodes.nodeType.length === 0) {
      throw new Error(
        "the engine returned an empty page snapshot; the page may still be loading, call browser_read again",
      );
    }
    const url = strings[document.documentURL ?? -1] ?? "";
    const title = strings[document.title ?? -1] ?? "";
    const ctx = serialize(nodes, strings);
    let body = ctx.out;
    if (ctx.truncated) body += `\n\n…(page content truncated at ${MAX_MARKDOWN_CHARS} characters)`;
    if (!body.trim()) body = "(no readable text on the page)";
    if (ctx.refs.length > 0) {
      const list = ctx.refs
        .map(
          (r) =>
            `- [${r.ref}] → node ${r.node} · ${r.kind} "${r.text}"${r.href ? ` → ${r.href}` : ""}`,
        )
        .join("\n");
      body += `\n\nInteractive elements:\n${list}`;
    }
    return { markdown: body, url, title, refs: ctx.refs, truncated: ctx.truncated };
  });
}
