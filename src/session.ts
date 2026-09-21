// src/session.ts
// Session state (feature 9, spec 0008): the cookie side of a real session. These
// operations ride the CDP connection the plugin already holds. Probe verified on
// obscura 0.2.2: the engine answers Network.setCookie, Network.getAllCookies,
// Network.deleteCookies, Storage.getCookies and Storage.setCookies even though
// the plugin's capability probe reports only four domains and never asks.
//
// This module is the only place in the plugin that touches a cookie value, so
// the value is dropped at the door: a listed cookie becomes a report row that
// carries no value at all, which makes leaking one a compile error rather than a
// discipline to remember (spec 0008 AC-4).

import { existsSync, readFileSync } from "node:fs";
import { runOp, send } from "./browser.js";
import type { EngineHandle } from "./supervisor.js";

/** AC-4: the one spelling of "this is deliberately hidden" in every report. */
export const REDACTED = "<redacted>";

/** A cookie as a report may show it: everything a person needs, and never the value. */
export interface CookieRow {
  name: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** The engine's sameSite attribute, when it reported one. */
  sameSite: string | undefined;
  /** An ISO date for a stored cookie; absent for a session cookie. */
  expiresAt: string | undefined;
}

/** A cookie as a caller supplies it, in an export file or one at a time. */
export interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  /** Unix seconds, as the engine and every export format report it. */
  expires?: number;
}

interface RawCookie {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expires?: number;
  session?: boolean;
}

// The one mapper from an engine cookie to a report row. It reads the value's
// field nowhere, so a value cannot travel through it even by mistake.
function toRow(cookie: RawCookie): CookieRow {
  const expiresAt =
    typeof cookie.expires === "number" && cookie.expires > 0
      ? new Date(cookie.expires * 1000).toISOString()
      : undefined;
  return {
    name: cookie.name ?? "",
    domain: cookie.domain ?? "",
    path: cookie.path ?? "/",
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    sameSite: cookie.sameSite,
    expiresAt,
  };
}

// A domain filter matches the cookie's domain as a substring, so "example.com"
// finds "example.com" and ".example.com" alike.
function matchesDomain(cookie: RawCookie, domain: string | undefined): boolean {
  if (!domain) return true;
  return (cookie.domain ?? "").includes(domain);
}

/** AC-3: the cookies for a domain, or the whole jar, with every value dropped. */
export async function listCookies(
  handle: EngineHandle,
  domain?: string,
  signal?: AbortSignal,
): Promise<CookieRow[]> {
  return runOp("the cookie list", signal, async () => {
    const response = (await send(handle, "Network.getAllCookies", {})) as {
      cookies?: RawCookie[];
    };
    return (response?.cookies ?? []).filter((cookie) => matchesDomain(cookie, domain)).map(toRow);
  });
}

/** AC-3: clear the cookies for a domain, or the whole jar, and say how many went. */
export async function clearCookies(
  handle: EngineHandle,
  domain?: string,
  signal?: AbortSignal,
): Promise<number> {
  return runOp("the cookie clear", signal, async () => {
    const response = (await send(handle, "Network.getAllCookies", {})) as {
      cookies?: RawCookie[];
    };
    const doomed = (response?.cookies ?? []).filter((cookie) => matchesDomain(cookie, domain));
    for (const cookie of doomed) {
      await send(handle, "Network.deleteCookies", {
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
      });
    }
    return doomed.length;
  });
}

/**
 * Set one cookie for a site. The value is an argument here and nowhere else: the
 * caller (an import, spec 0008 AC-1) has already validated every entry, so this
 * only reports whether the engine accepted it.
 */
export async function setCookie(
  handle: EngineHandle,
  entry: CookieEntry,
  signal?: AbortSignal,
): Promise<boolean> {
  return runOp("the cookie set", signal, async () => {
    const params: Record<string, unknown> = {
      name: entry.name,
      value: entry.value,
      domain: entry.domain,
      path: entry.path ?? "/",
    };
    if (entry.secure !== undefined) params.secure = entry.secure;
    if (entry.httpOnly !== undefined) params.httpOnly = entry.httpOnly;
    if (entry.sameSite !== undefined) params.sameSite = entry.sameSite;
    if (entry.expires !== undefined) params.expires = entry.expires;
    const response = (await send(handle, "Network.setCookie", params)) as { success?: boolean };
    return response?.success === true;
  });
}

/** What an import did, in the numbers a report shows. */
export interface ImportReport {
  /** How many entries the engine accepted. */
  imported: number;
  /** How many the engine turned down after validation passed. */
  refused: number;
  /** Plain words for the first engine refusal, when there was one. */
  reason: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// AC-5: every entry is checked before the first write, and a refusal names the
// entry and the field, so a bad file never leaves half a session behind.
function entryAt(item: unknown, index: number): CookieEntry {
  const where = `cookie ${index + 1}`;
  if (!isRecord(item)) throw new Error(`${where} is not an object, so it cannot be a cookie`);
  const name = item.name;
  const value = item.value;
  const domain = item.domain;
  if (typeof name !== "string" || name.trim() === "") throw new Error(`${where} has no name`);
  if (typeof value !== "string") throw new Error(`${where} ("${name}") has no value`);
  if (typeof domain !== "string" || domain.trim() === "") {
    throw new Error(`${where} ("${name}") has no domain, so there is nowhere to set it`);
  }
  return {
    name,
    value,
    domain,
    ...(typeof item.path === "string" ? { path: item.path } : {}),
    ...(typeof item.secure === "boolean" ? { secure: item.secure } : {}),
    ...(typeof item.httpOnly === "boolean" ? { httpOnly: item.httpOnly } : {}),
    ...(typeof item.sameSite === "string" ? { sameSite: item.sameSite } : {}),
    ...(typeof item.expires === "number" && item.expires > 0 ? { expires: item.expires } : {}),
  };
}

/**
 * Read a cookie export. Two shapes are accepted because they are the two a
 * caller will have: a bare list of cookies (the engine's own `cookies.json`, and
 * the common browser extensions) and an object carrying a `cookies` list (a
 * Playwright or MCP storage state export).
 */
export function parseCookieExport(raw: unknown): CookieEntry[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.cookies)
      ? raw.cookies
      : undefined;
  if (!list) {
    throw new Error(
      'the file does not hold a cookie export. Give either a list of cookies, or an object with a "cookies" list.',
    );
  }
  if (list.length === 0)
    throw new Error("the cookie export is empty, so there is nothing to import");
  return list.map((item, index) => entryAt(item, index));
}

/**
 * AC-1, AC-5: read an export file and set every cookie in it. A missing file, an
 * unreadable one, an unrecognised shape or a bad entry refuses before the first
 * write, so the jar is untouched when an import is refused. An entry the engine
 * itself turns down is counted and reported rather than rolled back, because the
 * plugin cannot undo a write the engine accepted.
 */
export async function importCookies(
  handle: EngineHandle,
  path: string,
  signal?: AbortSignal,
): Promise<ImportReport> {
  if (!existsSync(path)) {
    throw new Error(
      `the cookie file ${path} does not exist. Check the path, and export the cookies from the browser that holds the session.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "it is not valid JSON";
    throw new Error(
      `the cookie file ${path} could not be read as JSON (${detail}). Fix the file, or export it again.`,
    );
  }

  const entries = parseCookieExport(raw);
  let imported = 0;
  let refused = 0;
  let reason: string | undefined;
  for (const entry of entries) {
    if (await setCookie(handle, entry, signal)) {
      imported += 1;
    } else {
      refused += 1;
      reason ??= `the engine turned down the cookie "${entry.name}" for ${entry.domain}`;
    }
  }
  return { imported, refused, reason };
}
