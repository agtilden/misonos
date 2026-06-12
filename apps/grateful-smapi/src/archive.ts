interface ArchiveFile {
  name: string;
  format?: string;
  length?: string;
  source?: string;
  track?: string;
}

interface CacheEntry {
  files: ArchiveFile[];
  expires: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const PREFIX_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 6000;
const itemCache = new Map<string, CacheEntry>();
const prefixCache = new Map<string, { prefix: string; expires: number }>();

export async function resolveMp3Url(itemId: string, dbFilename: string, trackNumber: number): Promise<string | null> {
  const files = await fetchItemFiles(itemId);
  const filename = files.length === 0 ? dbFilename : pickFilename(files, dbFilename, trackNumber);
  if (!filename) return null;
  const prefix = await getCdnPrefix(itemId, filename);
  if (!prefix) return canonicalUrl(itemId, filename);
  return `${prefix}/${encodeFilenameForUrl(filename)}`;
}

function canonicalUrl(itemId: string, filename: string): string {
  return `https://archive.org/download/${encodeURIComponent(itemId)}/${encodeFilenameForUrl(filename)}`;
}

function encodeFilenameForUrl(filename: string): string {
  // archive.org keeps the dots and dashes; only escape true URL-unsafe characters.
  return encodeURIComponent(filename).replace(/'/g, "%27");
}

async function getCdnPrefix(itemId: string, sampleFilename: string): Promise<string | null> {
  const now = Date.now();
  const cached = prefixCache.get(itemId);
  if (cached && cached.expires > now) return cached.prefix;
  const url = canonicalUrl(itemId, sampleFilename);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    if (!response.ok || !response.url) return cached?.prefix ?? null;
    const finalUrl = response.url;
    const lastSlash = finalUrl.lastIndexOf("/");
    if (lastSlash < 0) return cached?.prefix ?? null;
    const prefix = finalUrl.slice(0, lastSlash);
    prefixCache.set(itemId, { prefix, expires: now + PREFIX_TTL_MS });
    return prefix;
  } catch {
    return cached?.prefix ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchItemFiles(itemId: string): Promise<ArchiveFile[]> {
  const now = Date.now();
  const cached = itemCache.get(itemId);
  if (cached && cached.expires > now) return cached.files;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`https://archive.org/metadata/${encodeURIComponent(itemId)}/files`, {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });
    if (!response.ok) return cached?.files ?? [];
    const data = (await response.json()) as { result?: ArchiveFile[] };
    const files = Array.isArray(data.result) ? data.result : [];
    itemCache.set(itemId, { files, expires: now + CACHE_TTL_MS });
    return files;
  } catch {
    return cached?.files ?? [];
  } finally {
    clearTimeout(timer);
  }
}

function pickFilename(files: ArchiveFile[], dbFilename: string, trackNumber: number): string | null {
  const mp3s = files.filter((file) => (file.format ?? "").toUpperCase().includes("MP3") || /\.mp3$/i.test(file.name));
  if (mp3s.length === 0) return null;
  const names = new Set(mp3s.map((file) => file.name));

  if (names.has(dbFilename)) return dbFilename;

  const candidates = [
    dbFilename.replace(/_vbr\.mp3$/i, ".mp3"),
    dbFilename.replace(/_64kb\.mp3$/i, ".mp3"),
    dbFilename.replace(/_64kb_64kb\.mp3$/i, ".mp3"),
    dbFilename.replace(/\.mp3$/i, "_vbr.mp3")
  ];
  for (const candidate of candidates) if (names.has(candidate)) return candidate;

  // Fall back to position: pick the Nth file from the sorted "original" MP3 list.
  const originals = mp3s.filter((file) => (file.source ?? "original") === "original");
  const sortable = originals.length > 0 ? originals : mp3s;
  const sorted = sortable.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (trackNumber >= 0 && trackNumber < sorted.length) return sorted[trackNumber].name;
  return null;
}
