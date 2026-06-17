import type { Generated } from "kysely";

// Kysely row types for the writable MiSonos bridge DB. snake_case columns; SQLite
// has no native boolean (loudness is 0/1) and timestamps are ISO-8601 text.
// These stay bridge-local — only the bridge touches the DB. The camelCase wire
// shapes live in @misonos/sonos-protocol (Preference, RecentlyViewedItem, EqPreset).

export interface PreferenceTable {
  key: string; // primary key
  value: string; // JSON-encoded value
  updated_at: string; // ISO-8601
}

export interface RecentlyViewedTable {
  id: Generated<number>;
  source_id: string;
  item_id: string;
  kind: string; // SourceItemKind
  title: string;
  subtitle: string | null;
  viewed_at: string; // ISO-8601
}

export interface EqPresetTable {
  id: Generated<number>;
  name: string;
  bass: number; // -10..10
  treble: number; // -10..10
  loudness: number; // 0 | 1
  created_at: string; // ISO-8601
}

export interface FavoriteTable {
  id: Generated<number>;
  kind: string; // "track" | "album" | "radio"
  source_id: string;
  item_id: string;
  title: string;
  subtitle: string | null;
  artist: string | null;
  album: string | null;
  image: string | null; // albumArtUri / station logo
  preset: Generated<number>; // 0 | 1 — pinned for one-tap tuning
  created_at: string; // ISO-8601
}

export interface PlaylistTable {
  id: Generated<number>;
  name: string;
  created_at: string; // ISO-8601
  updated_at: string; // ISO-8601
}

export interface PlaylistItemTable {
  id: Generated<number>;
  playlist_id: number;
  position: number;
  source_id: string;
  track_id: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration_seconds: number | null;
  added_at: string; // ISO-8601
}

export interface Database {
  preference: PreferenceTable;
  recently_viewed: RecentlyViewedTable;
  eq_preset: EqPresetTable;
  favorite: FavoriteTable;
  playlist: PlaylistTable;
  playlist_item: PlaylistItemTable;
}
