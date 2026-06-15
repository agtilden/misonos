import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import type http from "node:http";
import path from "node:path";

// Custom per-source logos uploaded from Settings, stored as a single
// `<sourceId>.<ext>` file in the bridge data dir so they survive restarts and are
// shared across every client. These override the built-in emblems shipped in the
// web app's `public/source-icons/`.

const MAX_ICON_BYTES = 2 * 1024 * 1024;

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif"
};

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
};

export interface SourceIconMeta {
  sourceId: string;
  ext: string;
  updatedAt: string;
}

// Source ids come from our own registry (e.g. "youtube-music"); restrict to a safe
// charset so the value can never escape the icons directory.
function safeSourceId(raw: string): string | null {
  return /^[a-z0-9][a-z0-9-]{0,63}$/i.test(raw) ? raw : null;
}

async function findIconFile(dir: string, sourceId: string): Promise<{ file: string; ext: string } | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const ext = path.extname(name).slice(1).toLowerCase();
    if (path.basename(name, path.extname(name)) === sourceId && ext in CONTENT_TYPE_BY_EXT) {
      return { file: path.join(dir, name), ext };
    }
  }
  return null;
}

export async function listSourceIcons(dir: string): Promise<SourceIconMeta[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const metas: SourceIconMeta[] = [];
  for (const name of names) {
    const ext = path.extname(name).slice(1).toLowerCase();
    const sourceId = path.basename(name, path.extname(name));
    if (!(ext in CONTENT_TYPE_BY_EXT) || !safeSourceId(sourceId)) continue;
    const info = await stat(path.join(dir, name)).catch(() => null);
    if (info) metas.push({ sourceId, ext, updatedAt: new Date(info.mtimeMs).toISOString() });
  }
  return metas;
}

export async function saveSourceIcon(
  dir: string,
  rawSourceId: string,
  contentType: string,
  buf: Buffer
): Promise<{ ok: true; meta: SourceIconMeta } | { ok: false; status: number; error: string }> {
  const sourceId = safeSourceId(rawSourceId);
  if (!sourceId) return { ok: false, status: 400, error: "Invalid source id" };
  const ext = EXT_BY_CONTENT_TYPE[contentType.split(";")[0].trim().toLowerCase()];
  if (!ext) return { ok: false, status: 415, error: "Unsupported image type (use SVG, PNG, JPEG, WebP, or GIF)" };
  if (buf.length === 0) return { ok: false, status: 400, error: "Empty upload" };
  if (buf.length > MAX_ICON_BYTES) return { ok: false, status: 413, error: "Image too large (max 2 MB)" };

  await mkdir(dir, { recursive: true });
  // Remove any existing icon for this source so a new extension fully replaces it.
  const existing = await findIconFile(dir, sourceId);
  if (existing) await unlink(existing.file).catch(() => undefined);
  await writeFile(path.join(dir, `${sourceId}.${ext}`), buf);
  return { ok: true, meta: { sourceId, ext, updatedAt: new Date().toISOString() } };
}

export async function deleteSourceIcon(dir: string, rawSourceId: string): Promise<boolean> {
  const sourceId = safeSourceId(rawSourceId);
  if (!sourceId) return false;
  const existing = await findIconFile(dir, sourceId);
  if (!existing) return false;
  await unlink(existing.file).catch(() => undefined);
  return true;
}

export async function serveSourceIcon(
  dir: string,
  rawSourceId: string,
  response: http.ServerResponse,
  isHead: boolean
): Promise<void> {
  const sourceId = safeSourceId(rawSourceId);
  const existing = sourceId ? await findIconFile(dir, sourceId) : null;
  if (!existing) {
    const body = JSON.stringify({ error: "No custom icon" });
    response.writeHead(404, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    response.end(body);
    return;
  }
  let buf: Buffer;
  try {
    buf = await readFile(existing.file);
  } catch {
    const body = JSON.stringify({ error: "No custom icon" });
    response.writeHead(404, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    response.end(body);
    return;
  }
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPE_BY_EXT[existing.ext],
    "Content-Length": buf.length,
    // Versioned by the `?v=` query the client sends, so it's safe to cache hard.
    "Cache-Control": "public, max-age=86400",
    "Access-Control-Allow-Origin": "*"
  });
  response.end(isHead ? undefined : buf);
}
