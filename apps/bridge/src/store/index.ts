import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import SqliteDatabase from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { Migrator } from "kysely/migration";
import type { EqPreset, Favorite, Playlist, PlaylistItem, Preference, RecentlyViewedItem, RecentQueue, SourceItemKind } from "@misonos/sonos-protocol";
import { migrationProvider } from "./migrations.js";
import type { Database } from "./schema.js";

const RECENTLY_VIEWED_CAP = 50;
const DEFAULT_RECENTLY_VIEWED_LIMIT = 50;
const RECENT_QUEUE_CAP = 3; // distinct recent queues kept per coordinator

/** A flat track row destined for a playlist (albums are expanded into these upstream). */
export interface PlaylistItemInput {
  sourceId: string;
  trackId: string;
  title: string;
  artist?: string | null;
  album?: string | null;
  durationSeconds?: number | null;
}

/** A track row of an archived queue (refs + display metadata). */
export interface RecentQueueItemInput {
  sourceId: string;
  trackId: string;
  title: string;
  artist?: string | null;
  album?: string | null;
}

export interface SaveRecentQueueInput {
  items: RecentQueueItemInput[];
  startTrack?: number | null; // 1-based track playing when archived
}

export interface Store {
  getPreference(key: string): Promise<Preference | undefined>;
  setPreference(key: string, value: unknown): Promise<Preference>;
  listRecentlyViewed(sourceId?: string, limit?: number): Promise<RecentlyViewedItem[]>;
  recordRecentlyViewed(input: Omit<RecentlyViewedItem, "viewedAt">): Promise<void>;
  listEqPresets(): Promise<EqPreset[]>;
  createEqPreset(input: Omit<EqPreset, "id" | "createdAt">): Promise<EqPreset>;
  deleteEqPreset(id: number): Promise<void>;
  // Favorites
  listFavorites(): Promise<Favorite[]>;
  addFavorite(input: Omit<Favorite, "id" | "createdAt" | "preset">): Promise<Favorite>;
  removeFavorite(sourceId: string, itemId: string): Promise<void>;
  setFavoritePreset(sourceId: string, itemId: string, preset: boolean): Promise<boolean>;
  // Playlists
  listPlaylists(): Promise<Playlist[]>;
  createPlaylist(name: string): Promise<Playlist>;
  renamePlaylist(id: number, name: string): Promise<Playlist>;
  deletePlaylist(id: number): Promise<void>;
  getPlaylist(id: number): Promise<{ playlist: Playlist; items: PlaylistItem[] } | undefined>;
  addPlaylistItems(id: number, items: PlaylistItemInput[]): Promise<PlaylistItem[]>;
  removePlaylistItem(playlistItemId: number): Promise<void>;
  reorderPlaylist(id: number, orderedItemIds: number[]): Promise<PlaylistItem[]>;
  // Per-playlist resume: remember/forget the track to resume at (by stable identity).
  setPlaylistResume(id: number, sourceId: string, trackId: string): Promise<void>;
  clearPlaylistResume(id: number): Promise<void>;
  // Recent queues: auto-archived music queues, keyed by coordinator UUID.
  saveRecentQueue(coordinatorUuid: string, input: SaveRecentQueueInput): Promise<RecentQueue | undefined>;
  listRecentQueues(coordinatorUuid: string): Promise<RecentQueue[]>;
  getRecentQueueRefs(id: number): Promise<{ items: { sourceId: string; trackId: string }[]; startTrack: number | null } | undefined>;
  deleteRecentQueue(id: number): Promise<void>;
  close(): Promise<void>;
}

export async function createStore(dbPath: string): Promise<Store> {
  if (dbPath !== ":memory:") {
    await mkdir(dirname(dbPath), { recursive: true });
  }
  const sqlite = new SqliteDatabase(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });

  const migrator = new Migrator({ db, provider: migrationProvider });
  const { error, results } = await migrator.migrateToLatest();
  for (const result of results ?? []) {
    if (result.status === "Error") {
      console.error(`[store] migration failed: ${result.migrationName}`);
    }
  }
  if (error) {
    await db.destroy();
    throw error instanceof Error ? error : new Error(String(error));
  }

  const loadPlaylist = async (id: number): Promise<{ playlist: Playlist; items: PlaylistItem[] } | undefined> => {
    const playlistRow = await db.selectFrom("playlist").selectAll().where("id", "=", id).executeTakeFirst();
    if (!playlistRow) return undefined;
    const itemRows = await db
      .selectFrom("playlist_item")
      .selectAll()
      .where("playlist_id", "=", id)
      .orderBy("position", "asc")
      .execute();
    const playlist = toPlaylist({ ...playlistRow, item_count: itemRows.length });
    playlist.resumeTrackNumber = computeResumeTrackNumber(itemRows, playlistRow.resume_source_id, playlistRow.resume_track_id);
    return { playlist, items: itemRows.map(toPlaylistItem) };
  };

  return {
    async getPreference(key: string): Promise<Preference | undefined> {
      const row = await db
        .selectFrom("preference")
        .selectAll()
        .where("key", "=", key)
        .executeTakeFirst();
      return row ? toPreference(row) : undefined;
    },

    async setPreference(key: string, value: unknown): Promise<Preference> {
      const updatedAt = new Date().toISOString();
      const encoded = JSON.stringify(value ?? null);
      await db
        .insertInto("preference")
        .values({ key, value: encoded, updated_at: updatedAt })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value: encoded, updated_at: updatedAt }))
        .execute();
      return { key, value: value ?? null, updatedAt };
    },

    async listRecentlyViewed(sourceId?: string, limit: number = DEFAULT_RECENTLY_VIEWED_LIMIT): Promise<RecentlyViewedItem[]> {
      // Order by autoincrement id, not viewed_at: ISO timestamps are only ms-resolution
      // and tie under rapid inserts. id is strictly monotonic, and the move-to-top
      // delete-then-insert gives the refreshed row a new (higher) id == most recent.
      let query = db.selectFrom("recently_viewed").selectAll().orderBy("id", "desc").limit(limit);
      if (sourceId) query = query.where("source_id", "=", sourceId);
      const rows = await query.execute();
      return rows.map(toRecentlyViewed);
    },

    async recordRecentlyViewed(input: Omit<RecentlyViewedItem, "viewedAt">): Promise<void> {
      const viewedAt = new Date().toISOString();
      await db.transaction().execute(async (tx) => {
        // Move-to-top: drop any existing row for this (source, item) then re-insert fresh.
        await tx
          .deleteFrom("recently_viewed")
          .where("source_id", "=", input.sourceId)
          .where("item_id", "=", input.itemId)
          .execute();
        await tx
          .insertInto("recently_viewed")
          .values({
            source_id: input.sourceId,
            item_id: input.itemId,
            kind: input.kind,
            title: input.title,
            subtitle: input.subtitle ?? null,
            viewed_at: viewedAt
          })
          .execute();
        // Cap: keep only the newest N rows globally.
        await tx
          .deleteFrom("recently_viewed")
          .where("id", "not in", (eb) =>
            eb.selectFrom("recently_viewed").select("id").orderBy("id", "desc").limit(RECENTLY_VIEWED_CAP)
          )
          .execute();
      });
    },

    async listEqPresets(): Promise<EqPreset[]> {
      const rows = await db.selectFrom("eq_preset").selectAll().orderBy("created_at", "desc").execute();
      return rows.map(toEqPreset);
    },

    async createEqPreset(input: Omit<EqPreset, "id" | "createdAt">): Promise<EqPreset> {
      const createdAt = new Date().toISOString();
      const row = await db
        .insertInto("eq_preset")
        .values({
          name: input.name,
          bass: clampEq(input.bass),
          treble: clampEq(input.treble),
          loudness: input.loudness ? 1 : 0,
          created_at: createdAt
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toEqPreset(row);
    },

    async deleteEqPreset(id: number): Promise<void> {
      await db.deleteFrom("eq_preset").where("id", "=", id).execute();
    },

    async listFavorites(): Promise<Favorite[]> {
      const rows = await db.selectFrom("favorite").selectAll().orderBy("id", "desc").execute();
      return rows.map(toFavorite);
    },

    async addFavorite(input: Omit<Favorite, "id" | "createdAt" | "preset">): Promise<Favorite> {
      const createdAt = new Date().toISOString();
      const values = {
        kind: input.kind,
        source_id: input.sourceId,
        item_id: input.itemId,
        title: input.title,
        subtitle: input.subtitle ?? null,
        artist: input.artist ?? null,
        album: input.album ?? null,
        image: input.albumArtUri ?? null,
        created_at: createdAt
      };
      const row = await db
        .insertInto("favorite")
        .values(values)
        // Idempotent: re-favoriting the same (source, item) refreshes metadata, not a dupe.
        // `preset` is intentionally left out so re-favoriting never clears a preset.
        .onConflict((oc) =>
          oc.columns(["source_id", "item_id"]).doUpdateSet({
            kind: input.kind,
            title: input.title,
            subtitle: input.subtitle ?? null,
            artist: input.artist ?? null,
            album: input.album ?? null,
            image: input.albumArtUri ?? null
          })
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return toFavorite(row);
    },

    async removeFavorite(sourceId: string, itemId: string): Promise<void> {
      // Deleting the row also drops any preset — presets can't outlive their favorite.
      await db.deleteFrom("favorite").where("source_id", "=", sourceId).where("item_id", "=", itemId).execute();
    },

    async setFavoritePreset(sourceId: string, itemId: string, preset: boolean): Promise<boolean> {
      // Only radio favorites are preset-eligible. Promotion requires an existing
      // radio favorite (callers favorite first); demotion is always allowed and
      // idempotent. Returns false when a non-radio/missing favorite is promoted.
      if (preset) {
        const row = await db
          .selectFrom("favorite")
          .select("kind")
          .where("source_id", "=", sourceId)
          .where("item_id", "=", itemId)
          .executeTakeFirst();
        if (row?.kind !== "radio") return false;
      }
      await db
        .updateTable("favorite")
        .set({ preset: preset ? 1 : 0 })
        .where("source_id", "=", sourceId)
        .where("item_id", "=", itemId)
        // Defence in depth: never flip preset on a non-radio row.
        .where("kind", "=", "radio")
        .execute();
      return true;
    },

    async listPlaylists(): Promise<Playlist[]> {
      const rows = await db
        .selectFrom("playlist")
        .selectAll()
        .select((eb) =>
          eb
            .selectFrom("playlist_item")
            .select((e) => e.fn.countAll<number>().as("c"))
            .whereRef("playlist_item.playlist_id", "=", "playlist.id")
            .as("item_count")
        )
        .orderBy("updated_at", "desc")
        .execute();
      return rows.map(toPlaylist);
    },

    async createPlaylist(name: string): Promise<Playlist> {
      const now = new Date().toISOString();
      const row = await db
        .insertInto("playlist")
        .values({ name, created_at: now, updated_at: now })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toPlaylist({ ...row, item_count: 0 });
    },

    async renamePlaylist(id: number, name: string): Promise<Playlist> {
      const updatedAt = new Date().toISOString();
      await db.updateTable("playlist").set({ name, updated_at: updatedAt }).where("id", "=", id).execute();
      const result = await loadPlaylist(id);
      if (!result) throw new Error("Playlist not found");
      return result.playlist;
    },

    async deletePlaylist(id: number): Promise<void> {
      // playlist_item rows go with it via ON DELETE CASCADE (foreign_keys = ON).
      await db.deleteFrom("playlist").where("id", "=", id).execute();
    },

    async getPlaylist(id: number): Promise<{ playlist: Playlist; items: PlaylistItem[] } | undefined> {
      return loadPlaylist(id);
    },

    async addPlaylistItems(id: number, items: PlaylistItemInput[]): Promise<PlaylistItem[]> {
      if (items.length === 0) return [];
      const addedAt = new Date().toISOString();
      return db.transaction().execute(async (tx) => {
        const maxRow = await tx
          .selectFrom("playlist_item")
          .select((eb) => eb.fn.max("position").as("max"))
          .where("playlist_id", "=", id)
          .executeTakeFirst();
        let position = maxRow?.max === null || maxRow?.max === undefined ? 0 : Number(maxRow.max) + 1;
        const inserted = await tx
          .insertInto("playlist_item")
          .values(items.map((item) => ({
            playlist_id: id,
            position: position++,
            source_id: item.sourceId,
            track_id: item.trackId,
            title: item.title,
            artist: item.artist ?? null,
            album: item.album ?? null,
            duration_seconds: item.durationSeconds ?? null,
            added_at: addedAt
          })))
          .returningAll()
          .execute();
        await tx.updateTable("playlist").set({ updated_at: addedAt }).where("id", "=", id).execute();
        return inserted.map(toPlaylistItem);
      });
    },

    async removePlaylistItem(playlistItemId: number): Promise<void> {
      await db.transaction().execute(async (tx) => {
        const row = await tx
          .selectFrom("playlist_item")
          .select(["playlist_id"])
          .where("id", "=", playlistItemId)
          .executeTakeFirst();
        if (!row) return;
        await tx.deleteFrom("playlist_item").where("id", "=", playlistItemId).execute();
        await renumberPlaylist(tx, row.playlist_id);
        await tx.updateTable("playlist").set({ updated_at: new Date().toISOString() }).where("id", "=", row.playlist_id).execute();
      });
    },

    async reorderPlaylist(id: number, orderedItemIds: number[]): Promise<PlaylistItem[]> {
      return db.transaction().execute(async (tx) => {
        const existing = await tx.selectFrom("playlist_item").select("id").where("playlist_id", "=", id).execute();
        const known = new Set(existing.map((r) => r.id));
        const sequence = orderedItemIds.filter((itemId) => known.has(itemId));
        // No UNIQUE(playlist_id, position), so a straight sequential rewrite is safe.
        for (let i = 0; i < sequence.length; i++) {
          await tx.updateTable("playlist_item").set({ position: i }).where("id", "=", sequence[i]).execute();
        }
        await tx.updateTable("playlist").set({ updated_at: new Date().toISOString() }).where("id", "=", id).execute();
        const rows = await tx
          .selectFrom("playlist_item")
          .selectAll()
          .where("playlist_id", "=", id)
          .orderBy("position", "asc")
          .execute();
        return rows.map(toPlaylistItem);
      });
    },

    async setPlaylistResume(id: number, sourceId: string, trackId: string): Promise<void> {
      // Intentionally does NOT touch updated_at — resume progress shouldn't reshuffle
      // the playlist list order on every track change.
      await db
        .updateTable("playlist")
        .set({ resume_source_id: sourceId, resume_track_id: trackId })
        .where("id", "=", id)
        .execute();
    },

    async clearPlaylistResume(id: number): Promise<void> {
      await db
        .updateTable("playlist")
        .set({ resume_source_id: null, resume_track_id: null })
        .where("id", "=", id)
        .execute();
    },

    async saveRecentQueue(coordinatorUuid: string, input: SaveRecentQueueInput): Promise<RecentQueue | undefined> {
      const items = input.items;
      if (items.length === 0) return undefined;
      const fingerprint = items.map((i) => `${i.sourceId}:${i.trackId}`).join("|");
      const capturedAt = new Date().toISOString();
      return db.transaction().execute(async (tx) => {
        // Dedupe: an identical capture for this coordinator just moves to the top.
        await tx
          .deleteFrom("recent_queue")
          .where("coordinator_uuid", "=", coordinatorUuid)
          .where("fingerprint", "=", fingerprint)
          .execute();
        const row = await tx
          .insertInto("recent_queue")
          .values({
            coordinator_uuid: coordinatorUuid,
            title: items[0].title,
            item_count: items.length,
            start_track: input.startTrack ?? null,
            fingerprint,
            captured_at: capturedAt
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await tx
          .insertInto("recent_queue_item")
          .values(items.map((it, index) => ({
            recent_queue_id: row.id,
            position: index,
            source_id: it.sourceId,
            track_id: it.trackId,
            title: it.title,
            artist: it.artist ?? null,
            album: it.album ?? null
          })))
          .execute();
        // Cap at the newest N per coordinator (items cascade on delete).
        await tx
          .deleteFrom("recent_queue")
          .where("coordinator_uuid", "=", coordinatorUuid)
          .where("id", "not in", (eb) =>
            eb.selectFrom("recent_queue").select("id").where("coordinator_uuid", "=", coordinatorUuid).orderBy("id", "desc").limit(RECENT_QUEUE_CAP)
          )
          .execute();
        return toRecentQueue(row);
      });
    },

    async listRecentQueues(coordinatorUuid: string): Promise<RecentQueue[]> {
      const rows = await db
        .selectFrom("recent_queue")
        .selectAll()
        .where("coordinator_uuid", "=", coordinatorUuid)
        .orderBy("id", "desc")
        .execute();
      return rows.map(toRecentQueue);
    },

    async getRecentQueueRefs(id: number): Promise<{ items: { sourceId: string; trackId: string }[]; startTrack: number | null } | undefined> {
      const row = await db.selectFrom("recent_queue").select(["start_track"]).where("id", "=", id).executeTakeFirst();
      if (!row) return undefined;
      const items = await db
        .selectFrom("recent_queue_item")
        .select(["source_id", "track_id"])
        .where("recent_queue_id", "=", id)
        .orderBy("position", "asc")
        .execute();
      return { items: items.map((r) => ({ sourceId: r.source_id, trackId: r.track_id })), startTrack: row.start_track };
    },

    async deleteRecentQueue(id: number): Promise<void> {
      await db.deleteFrom("recent_queue").where("id", "=", id).execute();
    },

    async close(): Promise<void> {
      await db.destroy();
    }
  };
}

function toRecentQueue(row: {
  id: number;
  coordinator_uuid: string;
  title: string;
  item_count: number;
  start_track: number | null;
  captured_at: string;
}): RecentQueue {
  return {
    id: row.id,
    coordinatorUuid: row.coordinator_uuid,
    title: row.title,
    itemCount: row.item_count,
    startTrack: row.start_track,
    capturedAt: row.captured_at
  };
}

// The 1-based track to resume "Play all" at, or null to start from the top. We
// resume only when the saved track still exists and is neither the first nor the
// last track: at the top there's nothing to resume, and at the end the playlist
// effectively finished — both start over.
function computeResumeTrackNumber(
  items: Array<{ source_id: string; track_id: string }>,
  resumeSourceId: string | null,
  resumeTrackId: string | null
): number | null {
  if (!resumeSourceId || !resumeTrackId) return null;
  const index = items.findIndex((row) => row.source_id === resumeSourceId && row.track_id === resumeTrackId);
  if (index <= 0 || index >= items.length - 1) return null;
  return index + 1;
}

async function renumberPlaylist(
  tx: Kysely<Database>,
  playlistId: number
): Promise<void> {
  const rows = await tx
    .selectFrom("playlist_item")
    .select("id")
    .where("playlist_id", "=", playlistId)
    .orderBy("position", "asc")
    .execute();
  for (let i = 0; i < rows.length; i++) {
    await tx.updateTable("playlist_item").set({ position: i }).where("id", "=", rows[i].id).execute();
  }
}

function toPreference(row: { key: string; value: string; updated_at: string }): Preference {
  return { key: row.key, value: parseJson(row.value), updatedAt: row.updated_at };
}

function toRecentlyViewed(row: {
  source_id: string;
  item_id: string;
  kind: string;
  title: string;
  subtitle: string | null;
  viewed_at: string;
}): RecentlyViewedItem {
  return {
    sourceId: row.source_id,
    itemId: row.item_id,
    kind: row.kind as SourceItemKind,
    title: row.title,
    subtitle: row.subtitle,
    viewedAt: row.viewed_at
  };
}

function toEqPreset(row: { id: number; name: string; bass: number; treble: number; loudness: number; created_at: string }): EqPreset {
  return {
    id: row.id,
    name: row.name,
    bass: row.bass,
    treble: row.treble,
    loudness: row.loudness !== 0,
    createdAt: row.created_at
  };
}

function toFavorite(row: {
  id: number;
  kind: string;
  source_id: string;
  item_id: string;
  title: string;
  subtitle: string | null;
  artist: string | null;
  album: string | null;
  image: string | null;
  preset: number;
  created_at: string;
}): Favorite {
  return {
    id: row.id,
    kind: row.kind === "album" ? "album" : row.kind === "radio" ? "radio" : "track",
    sourceId: row.source_id,
    itemId: row.item_id,
    title: row.title,
    subtitle: row.subtitle,
    artist: row.artist,
    album: row.album,
    albumArtUri: row.image,
    preset: row.preset === 1,
    createdAt: row.created_at
  };
}

function toPlaylist(row: { id: number; name: string; created_at: string; updated_at: string; item_count?: number | string | bigint | null }): Playlist {
  return {
    id: row.id,
    name: row.name,
    itemCount: row.item_count === undefined || row.item_count === null ? 0 : Number(row.item_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toPlaylistItem(row: {
  id: number;
  playlist_id: number;
  position: number;
  source_id: string;
  track_id: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration_seconds: number | null;
  added_at: string;
}): PlaylistItem {
  return {
    id: row.id,
    playlistId: row.playlist_id,
    position: row.position,
    sourceId: row.source_id,
    trackId: row.track_id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    durationSeconds: row.duration_seconds,
    addedAt: row.added_at
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function clampEq(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-10, Math.min(10, Math.round(value)));
}
