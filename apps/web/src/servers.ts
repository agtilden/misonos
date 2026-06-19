// Saved MiSonos "locations" — each is a full MiSonos host (web + bridge) on some
// network. Switching is just navigating the browser to that host's URL: it serves its
// own app and bridge same-origin, so there's nothing cross-origin to configure. The
// list is persisted per-origin and travels via a URL param so it shows up everywhere.

export interface MisonosServer {
  name: string;
  url: string; // canonical origin, e.g. "http://shore-host:4317"
}

const STORAGE_KEY = "misonos.servers";
const PROPAGATE_PARAM = "misonos-servers";

export function currentOrigin(): string {
  return window.location.origin;
}

export function isCurrent(server: MisonosServer): boolean {
  return server.url === currentOrigin();
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

// Always include the origin we're served from, so "here" is visible and labelled.
function withCurrent(list: MisonosServer[]): MisonosServer[] {
  const here = currentOrigin();
  return list.some((s) => s.url === here) ? list : [...list, { name: window.location.hostname || "This server", url: here }];
}

export function loadServers(): MisonosServer[] {
  return withCurrent(dedupe(readRaw()));
}

export function saveServers(list: MisonosServer[]): MisonosServer[] {
  const next = withCurrent(dedupe(list));
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}

// On startup: merge any locations passed in via the propagate param, then strip it
// from the URL so it doesn't linger. Call once before the app reads the list.
export function importServersFromUrl(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get(PROPAGATE_PARAM);
    if (!raw) { saveServers(readRaw()); return; }
    const incoming = JSON.parse(raw);
    saveServers([...readRaw(), ...(Array.isArray(incoming) ? incoming : [])]);
    params.delete(PROPAGATE_PARAM);
    const qs = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
  } catch {
    saveServers(readRaw());
  }
}

// Navigate this tab to another location, carrying the whole list so it propagates.
export function switchToServer(target: MisonosServer, all: MisonosServer[]): void {
  const origin = normalizeUrl(target.url);
  if (!origin) return;
  try {
    const dest = new URL(origin);
    dest.searchParams.set(PROPAGATE_PARAM, JSON.stringify(dedupe(all)));
    window.location.href = dest.toString();
  } catch {
    window.location.href = origin;
  }
}
