// Live client for archive.org's Live Music Archive (the "etree" collection).
//
// Three endpoints are used:
//   - advancedsearch.php  — list band sub-collections and recordings (with paging via numFound)
//   - metadata/<id>       — a recording's track list + show metadata
//   - download/<id>/<f>   — the canonical media URL (302-redirects to the current CDN host)

const SEARCH_BASE = "https://archive.org/advancedsearch.php";
const METADATA_BASE = "https://archive.org/metadata";
const REQUEST_TIMEOUT_MS = 12000;

export interface Band {
  id: string;
  title: string;
  downloads?: number;
}

export interface Recording {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD (best effort)
  year: string;
  venue: string;
  artist: string;
}

export interface Track {
  fileIndex: number; // position within the ordered mp3 list — stable per item
  filename: string;
  title: string;
  trackNumber: number;
  durationSeconds: number;
}

export interface Item {
  id: string;
  title: string;
  artist: string;
  date: string;
  venue: string;
  tracks: Track[];
}

interface SearchDoc {
  identifier: string;
  title?: string | string[];
  date?: string;
  year?: string | number;
  venue?: string | string[];
  coverage?: string | string[];
  creator?: string | string[];
  downloads?: number;
}

interface ArchiveFile {
  name: string;
  title?: string;
  track?: string;
  length?: string;
  format?: string;
  source?: string;
}

interface CacheEntry<T> { value: T; expires: number }

const ONE_HOUR_MS = 60 * 60 * 1000;

export class ArchiveApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ArchiveApiError";
  }
}

export class ArchiveClient {
  private cache = new Map<string, CacheEntry<unknown>>();

  constructor(private readonly collection: string) {}

  /** Bands whose title begins with `letter`, sorted alphabetically, paged. */
  async bandsByLetter(letter: string, start: number, rows: number): Promise<{ total: number; bands: Band[] }> {
    const q = `collection:${this.collection} AND mediatype:collection AND firstTitle:${letter}`;
    const { total, items } = await this.cachedSearch(`letter:${letter}:${start}:${rows}`, q, ["titleSorter asc"], start, rows, toBand);
    return { total, bands: items };
  }

  /** Most-downloaded bands first, paged. */
  async popularBands(start: number, rows: number): Promise<{ total: number; bands: Band[] }> {
    const q = `collection:${this.collection} AND mediatype:collection`;
    const { total, items } = await this.cachedSearch(`popular:${start}:${rows}`, q, ["downloads desc"], start, rows, toBand);
    return { total, bands: items };
  }

  /** Recordings in a band collection, by date, paged. Optionally filtered to a single year. */
  async recordings(bandId: string, start: number, rows: number, year?: string): Promise<{ total: number; recordings: Recording[] }> {
    let q = `collection:${bandId} AND mediatype:etree`;
    if (year) q += ` AND year:${year}`;
    const key = `recs:${bandId}:${year ?? "*"}:${start}:${rows}`;
    const { total, items } = await this.cachedSearch(key, q, ["date asc"], start, rows, toRecording);
    return { total, recordings: items };
  }

  /** Earliest and latest years a band has recordings for (two cheap one-row queries). */
  async bandYearRange(bandId: string): Promise<{ min: number; max: number } | null> {
    return this.cached(`yearrange:${bandId}`, async () => {
      const q = `collection:${bandId} AND mediatype:etree AND year:[1 TO 9999]`;
      const [asc, desc] = await Promise.all([
        this.search(q, ["year asc"], 0, 1),
        this.search(q, ["year desc"], 0, 1)
      ]);
      const min = yearOf(asc.docs[0]);
      const max = yearOf(desc.docs[0]);
      if (min === null || max === null) return null;
      return { min, max };
    });
  }

  /** A recording's show metadata and ordered, playable mp3 track list. */
  async item(itemId: string): Promise<Item> {
    return this.cached(`item:${itemId}`, async () => {
      const data = await this.fetchJson<{ metadata?: Record<string, unknown>; files?: ArchiveFile[] }>(
        `${METADATA_BASE}/${encodeURIComponent(itemId)}`
      );
      const meta = data.metadata ?? {};
      const tracks = orderMp3s(data.files ?? []);
      return {
        id: itemId,
        title: firstString(meta.title) ?? itemId,
        artist: firstString(meta.creator) ?? "Unknown Artist",
        date: (firstString(meta.date) ?? "").slice(0, 10),
        venue: firstString(meta.venue) ?? firstString(meta.coverage) ?? "",
        tracks
      };
    });
  }

  /** The canonical download URL for a track — archive.org 302-redirects it to the live CDN host. */
  trackUrl(itemId: string, filename: string): string {
    return `https://archive.org/download/${encodeURIComponent(itemId)}/${encodeFilenameForUrl(filename)}`;
  }

  private async cachedSearch<T>(
    key: string,
    q: string,
    sort: string[],
    start: number,
    rows: number,
    map: (doc: SearchDoc) => T
  ): Promise<{ total: number; items: T[] }> {
    return this.cached(key, async () => {
      const { numFound, docs } = await this.search(q, sort, start, rows);
      return { total: numFound, items: docs.map(map) };
    });
  }

  private async search(q: string, sort: string[], start: number, rows: number): Promise<{ numFound: number; docs: SearchDoc[] }> {
    const params = new URLSearchParams();
    params.set("q", q);
    params.set("rows", String(rows));
    params.set("start", String(start));
    params.set("output", "json");
    for (const field of ["identifier", "title", "date", "year", "venue", "coverage", "creator", "downloads"]) {
      params.append("fl[]", field);
    }
    for (const s of sort) params.append("sort[]", s);
    const data = await this.fetchJson<{ response?: { numFound?: number; docs?: SearchDoc[] } }>(
      `${SEARCH_BASE}?${params.toString()}`
    );
    return {
      numFound: data.response?.numFound ?? 0,
      docs: Array.isArray(data.response?.docs) ? data.response!.docs! : []
    };
  }

  private async cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (entry && entry.expires > now) return entry.value;
    try {
      const value = await fetcher();
      this.cache.set(key, { value, expires: now + ONE_HOUR_MS });
      return value;
    } catch (error) {
      // If archive.org is unreachable or erroring, serve the last good value
      // (even if expired) rather than failing the browse (mirrors phish-smapi).
      if (error instanceof ArchiveApiError && entry) return entry.value;
      throw error;
    }
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
      if (!response.ok) throw new ArchiveApiError(`archive.org returned ${response.status} for ${url}`, response.status);
      return (await response.json()) as T;
    } catch (error) {
      // Normalize network failures, aborts/timeouts, and JSON parse errors into
      // ArchiveApiError so the cache layer can fall back to a stale value.
      if (error instanceof ArchiveApiError) throw error;
      const reason = error instanceof Error ? error.message : "unknown error";
      throw new ArchiveApiError(`archive.org request failed for ${url}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function toBand(doc: SearchDoc): Band {
  return { id: doc.identifier, title: firstString(doc.title) ?? doc.identifier, downloads: doc.downloads };
}

function toRecording(doc: SearchDoc): Recording {
  const date = (doc.date ?? "").slice(0, 10);
  const venue = firstString(doc.venue) ?? firstString(doc.coverage) ?? "";
  return {
    id: doc.identifier,
    title: firstString(doc.title) ?? doc.identifier,
    date,
    year: doc.year !== undefined ? String(doc.year) : date.slice(0, 4),
    venue,
    artist: firstString(doc.creator) ?? ""
  };
}

function orderMp3s(files: ArchiveFile[]): Track[] {
  const mp3s = files.filter((f) => (f.format ?? "").toUpperCase().includes("MP3") || /\.mp3$/i.test(f.name));
  // Prefer the "original" uploads; if everything is derived, keep them all.
  const originals = mp3s.filter((f) => (f.source ?? "original") === "original");
  const chosen = originals.length > 0 ? originals : mp3s;
  const sorted = chosen.slice().sort((a, b) => {
    const ta = trackNumberOf(a);
    const tb = trackNumberOf(b);
    if (ta !== tb) return ta - tb;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
  return sorted.map((file, index) => ({
    fileIndex: index,
    filename: file.name,
    title: file.title?.trim() || stripExtension(file.name),
    trackNumber: trackNumberOf(file),
    durationSeconds: parseLength(file.length)
  }));
}

function trackNumberOf(file: ArchiveFile): number {
  const parsed = Number.parseInt(file.track ?? "", 10);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function parseLength(value: string | undefined): number {
  if (!value) return 0;
  if (value.includes(":")) {
    const parts = value.split(":").map((p) => Number.parseInt(p, 10));
    if (parts.some((p) => Number.isNaN(p))) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0];
  }
  const seconds = Number.parseFloat(value);
  return Number.isNaN(seconds) ? 0 : Math.round(seconds);
}

function yearOf(doc: SearchDoc | undefined): number | null {
  if (!doc) return null;
  const raw = doc.year !== undefined ? String(doc.year) : (doc.date ?? "").slice(0, 4);
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") return value[0];
  return undefined;
}

function encodeFilenameForUrl(filename: string): string {
  // archive.org keeps dots and dashes literal; only escape true URL-unsafe characters.
  return encodeURIComponent(filename).replace(/'/g, "%27");
}
