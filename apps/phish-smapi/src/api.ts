import type { PhishConfig } from "./config.js";

const REQUEST_TIMEOUT_MS = 10000;

export interface PhishCoverArtUrls {
  large?: string;
  medium?: string;
  small?: string;
}

export interface PhishShow {
  id: number;
  date: string;
  venue_name?: string;
  venue?: { id?: number; name?: string; location?: string; slug?: string };
  tour_name?: string;
  tour?: { id?: number; name?: string };
  tracks?: PhishTrack[];
  cover_art_urls?: PhishCoverArtUrls;
  album_cover_url?: string;
}

export interface PhishTrack {
  id: number;
  slug?: string;
  title: string;
  duration?: number; // milliseconds
  mp3_url?: string;
  set_name?: string;
  position?: number;
  show_date?: string;
  venue_name?: string;
  songs?: { id: number; title: string }[];
  show?: { id: number; date: string; venue_name?: string; cover_art_urls?: PhishCoverArtUrls; album_cover_url?: string };
  cover_art_urls?: PhishCoverArtUrls;
  album_cover_url?: string;
}

export interface PhishSong {
  id: number;
  title: string;
  slug?: string;
  tracks_count?: number;
}

export interface PhishVenue {
  id: number;
  name: string;
  location?: string;
  slug?: string;
  shows_count?: number;
}

export interface PhishTour {
  id?: number;
  slug?: string;
  name: string;
  starts_on?: string;
  ends_on?: string;
  shows_count?: number;
}

export class PhishApiError extends Error {
  constructor(message: string, readonly status: number, readonly body?: string) {
    super(message);
    this.name = "PhishApiError";
  }
}

export class PhishApi {
  constructor(private readonly config: PhishConfig) {}

  async listYears(): Promise<string[]> {
    const data = await this.get<unknown>("/years");
    return expandPeriods(data);
  }

  async showsByYear(year: string): Promise<PhishShow[]> {
    const data = await this.get<unknown>(`/shows?year=${encodeURIComponent(year)}&per_page=400`);
    return readArray<PhishShow>(data, "shows").sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  }

  async show(id: string): Promise<PhishShow> {
    return this.get<PhishShow>(`/shows/${encodeURIComponent(id)}`);
  }

  async songs(): Promise<PhishSong[]> {
    const data = await this.get<unknown>("/songs?per_page=2000");
    return readArray<PhishSong>(data, "songs").sort((a, b) => a.title.localeCompare(b.title));
  }

  async venues(): Promise<PhishVenue[]> {
    const data = await this.get<unknown>("/venues?per_page=1000");
    return readArray<PhishVenue>(data, "venues").sort((a, b) => a.name.localeCompare(b.name));
  }

  async tours(): Promise<PhishTour[]> {
    const data = await this.get<unknown>("/tours?per_page=500");
    return readArray<PhishTour>(data, "tours").sort((a, b) => (b.starts_on ?? "").localeCompare(a.starts_on ?? ""));
  }

  async showsBySong(slug: string): Promise<PhishShow[]> {
    const data = await this.get<unknown>(`/tracks?song_slug=${encodeURIComponent(slug)}&per_page=1000`);
    const tracks = readArray<PhishTrack>(data, "tracks");
    const showMap = new Map<string, PhishShow>();
    for (const track of tracks) {
      const date = track.show?.date ?? track.show_date;
      if (!date || showMap.has(date)) continue;
      showMap.set(date, {
        id: track.show?.id ?? 0,
        date,
        venue_name: track.show?.venue_name ?? track.venue_name
      });
    }
    return Array.from(showMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  async showsByVenue(slug: string): Promise<PhishShow[]> {
    const data = await this.get<unknown>(`/shows?venue_slug=${encodeURIComponent(slug)}&per_page=400`);
    return readArray<PhishShow>(data, "shows").sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  }

  async showsByTour(tourId: string): Promise<PhishShow[]> {
    const data = await this.get<unknown>(`/tours/${encodeURIComponent(tourId)}`);
    return readArray<PhishShow>(data, "shows").sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  }

  async track(id: string): Promise<PhishTrack> {
    return this.get<PhishTrack>(`/tracks/${encodeURIComponent(id)}`);
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.config.apiBase}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      const text = await response.text();
      if (!response.ok) {
        throw new PhishApiError(`Phish.in API ${response.status} at ${path}`, response.status, text.slice(0, 400));
      }
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function readArray<T>(data: unknown, listKey: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (typeof data === "object" && data !== null) {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record[listKey])) return record[listKey] as T[];
    if (Array.isArray(record.items)) return record.items as T[];
    if (Array.isArray(record.data)) return record.data as T[];
  }
  return [];
}

function expandPeriods(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  const years = new Set<string>();
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const period = (entry as { period?: unknown }).period;
    if (typeof period !== "string") continue;
    const range = period.split("-");
    if (range.length === 2) {
      const start = Number.parseInt(range[0], 10);
      const end = Number.parseInt(range[1], 10);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start < 30) {
        for (let y = start; y <= end; y++) years.add(String(y));
        continue;
      }
    }
    years.add(period);
  }
  return Array.from(years).sort();
}
