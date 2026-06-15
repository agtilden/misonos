import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";

// YouTube Music's library/personalized surfaces require an authenticated WEB_REMIX
// identity. OAuth (auth.ts) is unreliable for those browse calls, so we let the user
// paste a "Copy as cURL" (or raw request headers) captured from music.youtube.com and
// replay its cookies + a computed SAPISIDHASH Authorization header on browse requests.
// See DEPLOY / settings UI for the capture steps.

const ORIGIN = "https://music.youtube.com";
const COOKIES_PATH = process.env.YTMUSIC_COOKIES_PATH ?? `${homedir()}/.misonos/ytmusic-cookies.json`;

interface CookieCreds {
  cookie: string;
  authUser: string;
}

let creds: CookieCreds | null = null;

export type CookieAuthStatus = { cookieAuth: "signed-in" | "signed-out" };

export function cookieAuthStatus(): CookieAuthStatus {
  return { cookieAuth: creds ? "signed-in" : "signed-out" };
}

export function hasCookieAuth(): boolean {
  return creds !== null;
}

// Build the auth headers for an authenticated YTM request, or {} when not signed in.
export function cookieAuthHeaders(): Record<string, string> {
  if (!creds) return {};
  const map = parseCookieMap(creds.cookie);
  const sapisid = map.SAPISID ?? map["__Secure-3PAPISID"] ?? map["__Secure-1PAPISID"];
  if (!sapisid) return {};
  return {
    Cookie: creds.cookie,
    Authorization: `SAPISIDHASH ${sapisidHash(sapisid)}`,
    "X-Goog-AuthUser": creds.authUser
  };
}

function sapisidHash(sapisid: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const digest = createHash("sha1").update(`${ts} ${sapisid} ${ORIGIN}`).digest("hex");
  return `${ts}_${digest}`;
}

function parseCookieMap(cookie: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const part of cookie.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    map[part.slice(0, eq).trim()] = part.slice(eq + 1);
  }
  return map;
}

// Pull the Cookie value out of a pasted cURL command or a raw request-header block.
// Handles `-H 'cookie: …'`, `-H "cookie: …"`, `-b '…'`, and bare `Cookie: …` lines.
function extractCookie(raw: string): string | undefined {
  const headerForms = [
    /-H\s+\$?'cookie:\s*([^']*)'/i,
    /-H\s+"cookie:\s*([^"]*)"/i,
    /-b\s+\$?'([^']*)'/i,
    /-b\s+"([^"]*)"/i,
    /^\s*cookie:\s*(.+)$/im
  ];
  for (const re of headerForms) {
    const match = raw.match(re);
    if (match && match[1].trim()) return match[1].trim();
  }
  return undefined;
}

function extractAuthUser(raw: string): string {
  const match = raw.match(/-H\s+\$?['"]x-goog-authuser:\s*([^'"]*)['"]/i) ?? raw.match(/^\s*x-goog-authuser:\s*(.+)$/im);
  return match ? match[1].trim() : "0";
}

// Validate + persist credentials from a pasted cURL/header blob. Throws a helpful
// message when the paste is missing the cookies we need.
export async function setCookiesFromPaste(raw: string): Promise<CookieAuthStatus> {
  const cookie = extractCookie(raw);
  if (!cookie) {
    throw new Error("Couldn't find a Cookie header. Use \"Copy as cURL\" from a music.youtube.com request and paste the whole thing.");
  }
  const map = parseCookieMap(cookie);
  const hasApiSid = !!(map.SAPISID || map["__Secure-3PAPISID"] || map["__Secure-1PAPISID"]);
  const hasSession = !!(map.SID || map["__Secure-3PSID"] || map["__Secure-1PSID"]);
  if (!hasApiSid || !hasSession) {
    throw new Error("Those cookies don't look signed in (missing SAPISID / SID). Copy the request from music.youtube.com while logged in.");
  }
  creds = { cookie, authUser: extractAuthUser(raw) };
  await persist(creds);
  return cookieAuthStatus();
}

export async function clearCookies(): Promise<CookieAuthStatus> {
  creds = null;
  await rm(COOKIES_PATH, { force: true }).catch(() => undefined);
  return cookieAuthStatus();
}

export async function restoreCookies(): Promise<void> {
  try {
    const data = await readFile(COOKIES_PATH, "utf8");
    const parsed = JSON.parse(data) as CookieCreds;
    if (parsed.cookie) {
      creds = { cookie: parsed.cookie, authUser: parsed.authUser ?? "0" };
      console.log("[ytmusic] restored saved cookie credentials");
    }
  } catch {
    /* no saved cookies — fine */
  }
}

async function persist(value: CookieCreds): Promise<void> {
  await mkdir(dirname(COOKIES_PATH), { recursive: true });
  await writeFile(COOKIES_PATH, JSON.stringify(value, null, 2), "utf8");
}
