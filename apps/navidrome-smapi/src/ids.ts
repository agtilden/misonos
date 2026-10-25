import type { AlbumListType } from "./subsonic.js";

export type NavidromeId =
  | { kind: "root" }
  | { kind: "artists" }
  | { kind: "albums" }
  | { kind: "genres" }
  | { kind: "playlists" }
  | { kind: "starred" }
  | { kind: "albumList"; list: AlbumListType }
  | { kind: "artist"; artistId: string }
  | { kind: "album"; albumId: string }
  | { kind: "playlist"; playlistId: string }
  | { kind: "genre"; genre: string }
  | { kind: "track"; songId: string };

const PREFIX = {
  root: "root",
  artists: "artists",
  albums: "albums",
  genres: "genres",
  playlists: "playlists",
  starred: "starred",
  albumList: "list",
  artist: "ar",
  album: "al",
  playlist: "pl",
  genre: "g",
  track: "t"
} as const;

const ALBUM_LISTS: readonly AlbumListType[] = ["newest", "recent", "frequent", "random", "alphabeticalByName"];

export function encodeId(id: NavidromeId): string {
  switch (id.kind) {
    case "root": return PREFIX.root;
    case "artists": return PREFIX.artists;
    case "albums": return PREFIX.albums;
    case "genres": return PREFIX.genres;
    case "playlists": return PREFIX.playlists;
    case "starred": return PREFIX.starred;
    case "albumList": return `${PREFIX.albumList}:${id.list}`;
    case "artist": return `${PREFIX.artist}:${id.artistId}`;
    case "album": return `${PREFIX.album}:${id.albumId}`;
    case "playlist": return `${PREFIX.playlist}:${id.playlistId}`;
    case "genre": return `${PREFIX.genre}:${id.genre}`;
    case "track": return `${PREFIX.track}:${id.songId}`;
  }
}

export function decodeId(raw: string): NavidromeId {
  if (raw === PREFIX.root) return { kind: "root" };
  if (raw === PREFIX.artists) return { kind: "artists" };
  if (raw === PREFIX.albums) return { kind: "albums" };
  if (raw === PREFIX.genres) return { kind: "genres" };
  if (raw === PREFIX.playlists) return { kind: "playlists" };
  if (raw === PREFIX.starred) return { kind: "starred" };
  const colon = raw.indexOf(":");
  if (colon < 0) throw new Error(`Unknown id: ${raw}`);
  const prefix = raw.slice(0, colon);
  // Everything after the first colon, so genre names may contain colons.
  const rest = raw.slice(colon + 1);
  if (!rest) throw new Error(`Empty id: ${raw}`);
  switch (prefix) {
    case PREFIX.albumList: {
      const list = ALBUM_LISTS.find((entry) => entry === rest);
      if (!list) throw new Error(`Unknown album list: ${rest}`);
      return { kind: "albumList", list };
    }
    case PREFIX.artist: return { kind: "artist", artistId: rest };
    case PREFIX.album: return { kind: "album", albumId: rest };
    case PREFIX.playlist: return { kind: "playlist", playlistId: rest };
    case PREFIX.genre: return { kind: "genre", genre: rest };
    case PREFIX.track: return { kind: "track", songId: rest };
    default: throw new Error(`Unknown id prefix: ${prefix}`);
  }
}
