import { createHash, randomBytes } from "node:crypto";
import type { NavidromeServer } from "./config.js";

const API_VERSION = "1.16.1";
const CLIENT_NAME = "MiSonos";
const REQUEST_TIMEOUT_MS = 10000;
// getAlbumList2 caps `size` at 500; A–Z pages through until a short page.
const ALBUM_PAGE_SIZE = 500;
const MAX_ALBUMS = 10000;

export interface SubsonicSong {
  id: string;
  title: string;
  album?: string;
  albumId?: string;
  artist?: string;
  artistId?: string;
  track?: number;
  discNumber?: number;
  year?: number;
  duration?: number; // seconds
  bitRate?: number; // kbps
  size?: number; // bytes
  suffix?: string;
  contentType?: string;
  coverArt?: string;
}

export interface SubsonicAlbum {
  id: string;
  name: string;
  artist?: string;
  artistId?: string;
  coverArt?: string;
  songCount?: number;
  duration?: number;
  year?: number;
  song?: SubsonicSong[];
}

export interface SubsonicArtist {
  id: string;
  name: string;
  albumCount?: number;
  coverArt?: string;
  album?: SubsonicAlbum[];
}

export interface SubsonicPlaylist {
  id: string;
  name: string;
  songCount?: number;
  duration?: number;
  coverArt?: string;
  owner?: string;
  comment?: string;
  entry?: SubsonicSong[];
}

export interface SubsonicGenre {
  value: string;
  songCount?: number;
  albumCount?: number;
}

export interface SubsonicResults {
  artist?: SubsonicArtist[];
  album?: SubsonicAlbum[];
  song?: SubsonicSong[];
}

export type AlbumListType = "newest" | "recent" | "frequent" | "random" | "alphabeticalByName";

type Params = Record<string, string | number | boolean | undefined>;

export class SubsonicError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "SubsonicError";
  }
}

export class SubsonicClient {
  constructor(private readonly server: NavidromeServer, private readonly fetchImpl: typeof fetch = fetch) {}

  // Token auth (API 1.13+): a fresh salt per request and t = md5(password + salt),
  // so the password itself never goes over the wire. These URLs still carry a
  // replayable token — keep them inside this service, never hand them out.
  url(endpoint: string, params: Params = {}): URL {
    const salt = randomBytes(8).toString("hex");
    const token = createHash("md5").update(this.server.password + salt).digest("hex");
    const url = new URL(`${this.server.serverUrl}/rest/${endpoint}`);
    url.searchParams.set("u", this.server.username);
    url.searchParams.set("t", token);
    url.searchParams.set("s", salt);
    url.searchParams.set("v", API_VERSION);
    url.searchParams.set("c", CLIENT_NAME);
    url.searchParams.set("f", "json");
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  async artists(): Promise<SubsonicArtist[]> {
    const data = await this.get<{ artists?: { index?: { artist?: SubsonicArtist[] }[] } }>("getArtists");
    return (data.artists?.index ?? []).flatMap((index) => index.artist ?? []);
  }

  async artist(id: string): Promise<SubsonicArtist> {
    return (await this.get<{ artist: SubsonicArtist }>("getArtist", { id })).artist;
  }

  async album(id: string): Promise<SubsonicAlbum> {
    return (await this.get<{ album: SubsonicAlbum }>("getAlbum", { id })).album;
  }

  async albumList(type: AlbumListType, size = 100): Promise<SubsonicAlbum[]> {
    if (type !== "alphabeticalByName") return this.albumPage({ type, size: Math.min(size, ALBUM_PAGE_SIZE) });
    const albums: SubsonicAlbum[] = [];
    for (let offset = 0; offset < MAX_ALBUMS; offset += ALBUM_PAGE_SIZE) {
      const page = await this.albumPage({ type, size: ALBUM_PAGE_SIZE, offset });
      albums.push(...page);
      if (page.length < ALBUM_PAGE_SIZE) break;
    }
    return albums;
  }

  async albumsByGenre(genre: string): Promise<SubsonicAlbum[]> {
    return this.albumPage({ type: "byGenre", genre, size: ALBUM_PAGE_SIZE });
  }

  async genres(): Promise<SubsonicGenre[]> {
    const data = await this.get<{ genres?: { genre?: SubsonicGenre[] } }>("getGenres");
    return data.genres?.genre ?? [];
  }

  async playlists(): Promise<SubsonicPlaylist[]> {
    const data = await this.get<{ playlists?: { playlist?: SubsonicPlaylist[] } }>("getPlaylists");
    return data.playlists?.playlist ?? [];
  }

  async playlist(id: string): Promise<SubsonicPlaylist> {
    return (await this.get<{ playlist: SubsonicPlaylist }>("getPlaylist", { id })).playlist;
  }

  async song(id: string): Promise<SubsonicSong> {
    return (await this.get<{ song: SubsonicSong }>("getSong", { id })).song;
  }

  async starred(): Promise<SubsonicResults> {
    return (await this.get<{ starred2?: SubsonicResults }>("getStarred2")).starred2 ?? {};
  }

  async search(query: string): Promise<SubsonicResults> {
    const data = await this.get<{ searchResult3?: SubsonicResults }>("search3", {
      query,
      artistCount: 20,
      albumCount: 40,
      songCount: 100
    });
    return data.searchResult3 ?? {};
  }

  private async albumPage(params: Params): Promise<SubsonicAlbum[]> {
    const data = await this.get<{ albumList2?: { album?: SubsonicAlbum[] } }>("getAlbumList2", params);
    return data.albumList2?.album ?? [];
  }

  private async get<T>(endpoint: string, params: Params = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      // Errors name the endpoint only: the URL carries the auth token.
      const response = await this.fetchImpl(this.url(endpoint, params), {
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) throw new SubsonicError(`Subsonic ${endpoint}: HTTP ${response.status}`);
      const body = JSON.parse(text) as { "subsonic-response"?: { status?: string; error?: { code?: number; message?: string } } };
      const payload = body["subsonic-response"];
      if (!payload) throw new SubsonicError(`Subsonic ${endpoint}: malformed response`);
      if (payload.status !== "ok") {
        throw new SubsonicError(`Subsonic ${endpoint}: ${payload.error?.message ?? "request failed"}`, payload.error?.code);
      }
      return payload as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
