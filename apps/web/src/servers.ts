// Saved MiSonos "locations" — each is a full MiSonos host (web + bridge) on some
// network. The app shell is always served from ONE origin (the "home" host you
// installed/opened it from); switching locations does NOT navigate there. Instead
// it repoints the API base at the chosen backend, so every /api call (fetch + SSE)
// goes cross-origin to that host. The bridge already answers with permissive CORS,
// so nothing cross-origin needs configuring. Keeping the browser on one origin is
// the whole point: an installed PWA is locked to the origin it was installed from,
// and navigating away from it triggers Chrome's out-of-scope banner. The saved list
// lives in the home origin's localStorage.

export interface MisonosServer {
  name: string;
  url: string; // canonical origin, e.g. "http://shore-host:4317"
}

const STORAGE_KEY = "misonos.servers";
const API_BASE_KEY = "misonos.apiBase";

/** The origin the app shell is served from — where the PWA is installed / in scope. */
export function homeOrigin(): string {
  return window.location.origin;
}

/** Origin of the backend API calls currently target ("" stored ⇒ home). */
export function apiBase(): string {
  try {
    return localStorage.getItem(API_BASE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Prefix an /api path with the selected backend origin (no-op when home). */
export function apiUrl(path: string): string {
  return apiBase() + path;
}

/** Point the API at `origin`; clearing (or selecting home) reverts to same-origin. */
function setApiBase(origin: string): void {
  try {
    if (!origin || origin === homeOrigin()) localStorage.removeItem(API_BASE_KEY);
    else localStorage.setItem(API_BASE_KEY, origin);
  } catch {
    /* ignore */
  }
}

/** The backend in use right now (selected base, or home when none is selected). */
export function currentServerUrl(): string {
  return apiBase() || homeOrigin();
}

export function isCurrent(server: MisonosServer): boolean {
  return server.url === currentServerUrl();
}

/** Coerce free-form input ("shore:4317", "http://x:4317/") to a canonical origin, or null. */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    return new URL(withProtocol).origin;
  } catch {
    return null;
  }
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function readRaw(): MisonosServer[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function dedupe(list: MisonosServer[]): MisonosServer[] {
  const seen = new Set<string>();
  const out: MisonosServer[] = [];
  for (const entry of list) {
    if (!entry || typeof entry.url !== "string") continue;
    const url = normalizeUrl(entry.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ name: (typeof entry.name === "string" && entry.name.trim()) || hostnameOf(url), url });
  }
  return out;
}

// Always include the home origin, so "here" is visible, labelled, and switchable-back-to.
function withHome(list: MisonosServer[]): MisonosServer[] {
  const here = homeOrigin();
  return list.some((s) => s.url === here) ? list : [...list, { name: window.location.hostname || "This server", url: here }];
}

export function loadServers(): MisonosServer[] {
  return withHome(dedupe(readRaw()));
}

export function saveServers(list: MisonosServer[]): MisonosServer[] {
  const next = withHome(dedupe(list));
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}

// Repoint the app at another location's backend, then reload (same origin, so the
// PWA stays in scope and no out-of-scope banner appears). A fresh load re-opens the
// SSE stream and re-fetches all state against the newly-selected backend.
export function switchToServer(target: MisonosServer): void {
  const origin = normalizeUrl(target.url);
  if (!origin) return;
  setApiBase(origin);
  window.location.reload();
}
