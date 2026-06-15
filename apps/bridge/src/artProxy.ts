import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { resolveItunesArt } from "./itunes.js";

const BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const MEMORY_CACHE_MAX = 256;
const DISK_CACHE_MAX_BYTES = 200 * 1024 * 1024;
const EVICT_EVERY = 50;
const FETCH_TIMEOUT_MS = 8000;

interface CachedArt { buf: Buffer; contentType: string }
const memoryCache = new Map<string, CachedArt>();
let writeCounter = 0;

// Serve album art for a `/api/art` request. Accepts either a direct `u=<url>` or a
// resolve descriptor (`artist`, `album`, `fallback`). Resolved bytes are cached on disk
// (survives restart) and in a hot in-memory layer, so iTunes/upstream is hit at most once.
export async function serveArt(
  query: URLSearchParams,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  cacheDir: string
): Promise<void> {
  const key = cacheKey(query);
  const isHead = request.method === "HEAD";

  // 1. In-memory hot cache.
  const hot = memoryCache.get(key);
  if (hot) return send(response, hot, isHead, "hit-memory");

  // 2. Disk cache.
  const diskPath = path.join(cacheDir, key);
  const fromDisk = await readDisk(diskPath);
  if (fromDisk) {
    rememberMemory(key, fromDisk);
    return send(response, fromDisk, isHead, "hit-disk");
  }

  // 3. Resolve a target URL and fetch the bytes.
  const fallback = query.get("fallback") ?? undefined;
  const target = await resolveTarget(query, fallback);
  if (!target) return fail(response, 404, "No art available");

  let art = await fetchImage(target);
  if (!art && fallback && fallback !== target) art = await fetchImage(fallback);
  if (!art) return fail(response, 502, "Art fetch failed");

  rememberMemory(key, art);
  void writeDisk(cacheDir, diskPath, art);
  return send(response, art, isHead, "miss");
}

async function resolveTarget(query: URLSearchParams, fallback: string | undefined): Promise<string | undefined> {
  const direct = query.get("u");
  if (direct) return direct;
  const itunes = await resolveItunesArt(query.get("artist") ?? undefined, query.get("album") ?? undefined);
  return itunes ?? fallback;
}

async function fetchImage(target: string): Promise<CachedArt | undefined> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const upstream = await fetch(url, {
      headers: { accept: "image/*,*/*", "user-agent": BROWSER_USER_AGENT },
      redirect: "follow",
      signal: controller.signal
    });
    if (!upstream.ok) return undefined;
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length === 0) return undefined;
    const contentType = upstream.headers.get("content-type")?.split(";")[0] || detectImageType(buf);
    if (!contentType.startsWith("image/")) return undefined;
    return { buf, contentType };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function send(response: http.ServerResponse, art: CachedArt, isHead: boolean, cacheState: string): void {
  response.writeHead(200, {
    "Content-Type": art.contentType,
    "Content-Length": art.buf.length,
    "Cache-Control": "public, max-age=86400",
    "Access-Control-Allow-Origin": "*",
    "X-Art-Cache": cacheState
  });
  response.end(isHead ? undefined : art.buf);
}

function cacheKey(query: URLSearchParams): string {
  const parts = [...query.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`);
  return createHash("sha1").update(parts.join("&")).digest("hex");
}

function rememberMemory(key: string, art: CachedArt): void {
  memoryCache.delete(key);
  memoryCache.set(key, art);
  if (memoryCache.size > MEMORY_CACHE_MAX) {
    const oldest = memoryCache.keys().next().value;
    if (oldest !== undefined) memoryCache.delete(oldest);
  }
}

async function readDisk(diskPath: string): Promise<CachedArt | undefined> {
  try {
    const buf = await readFile(diskPath);
    return { buf, contentType: detectImageType(buf) };
  } catch {
    return undefined;
  }
}

async function writeDisk(cacheDir: string, diskPath: string, art: CachedArt): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(diskPath, art.buf);
    if (++writeCounter % EVICT_EVERY === 0) await evictIfNeeded(cacheDir);
  } catch {
    /* cache write failures are non-fatal */
  }
}

async function evictIfNeeded(cacheDir: string): Promise<void> {
  try {
    const names = await readdir(cacheDir);
    const files = await Promise.all(names.map(async (name) => {
      const full = path.join(cacheDir, name);
      const info = await stat(full).catch(() => null);
      return info ? { full, size: info.size, mtime: info.mtimeMs } : null;
    }));
    const present = files.filter((f): f is { full: string; size: number; mtime: number } => f !== null);
    let total = present.reduce((sum, f) => sum + f.size, 0);
    if (total <= DISK_CACHE_MAX_BYTES) return;
    present.sort((a, b) => a.mtime - b.mtime); // oldest first
    for (const file of present) {
      if (total <= DISK_CACHE_MAX_BYTES) break;
      await unlink(file.full).catch(() => undefined);
      total -= file.size;
    }
  } catch {
    /* ignore */
  }
}

function detectImageType(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "image/jpeg";
}

function fail(response: http.ServerResponse, status: number, message: string): void {
  if (response.writableEnded) return;
  const body = JSON.stringify({ error: message });
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}
