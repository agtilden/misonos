import type { Kysely } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";

// Programmatic migrations — NOT FileMigrationProvider, which dynamically imports
// files and trips over NodeNext extension resolution. Keys are the migration
// names Kysely records in its bookkeeping table; keep them ordered and immutable.

const m001_init: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable("preference")
      .addColumn("key", "text", (c) => c.primaryKey())
      .addColumn("value", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createTable("recently_viewed")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("source_id", "text", (c) => c.notNull())
      .addColumn("item_id", "text", (c) => c.notNull())
      .addColumn("kind", "text", (c) => c.notNull())
      .addColumn("title", "text", (c) => c.notNull())
      .addColumn("subtitle", "text")
      .addColumn("viewed_at", "text", (c) => c.notNull())
      .execute();
    // Unique on (source_id, item_id) backs the delete-then-insert "move to top" upsert.
    await db.schema
      .createIndex("recently_viewed_unique")
      .on("recently_viewed")
      .columns(["source_id", "item_id"])
      .unique()
      .execute();
    await db.schema
      .createIndex("recently_viewed_viewed_at")
      .on("recently_viewed")
      .column("viewed_at")
      .execute();

    await db.schema
      .createTable("eq_preset")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("bass", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("treble", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("loudness", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable("eq_preset").execute();
    await db.schema.dropTable("recently_viewed").execute();
    await db.schema.dropTable("preference").execute();
  }
};

const m002_library: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable("favorite")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("kind", "text", (c) => c.notNull())
      .addColumn("source_id", "text", (c) => c.notNull())
      .addColumn("item_id", "text", (c) => c.notNull())
      .addColumn("title", "text", (c) => c.notNull())
      .addColumn("subtitle", "text")
      .addColumn("artist", "text")
      .addColumn("album", "text")
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();
    // One favorite per (source, item) — backs the toggle / dedupe upsert.
    await db.schema
      .createIndex("favorite_unique")
      .on("favorite")
      .columns(["source_id", "item_id"])
      .unique()
      .execute();

    await db.schema
      .createTable("playlist")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createTable("playlist_item")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("playlist_id", "integer", (c) => c.notNull().references("playlist.id").onDelete("cascade"))
      .addColumn("position", "integer", (c) => c.notNull())
      .addColumn("source_id", "text", (c) => c.notNull())
      .addColumn("track_id", "text", (c) => c.notNull())
      .addColumn("title", "text", (c) => c.notNull())
      .addColumn("artist", "text")
      .addColumn("album", "text")
      .addColumn("duration_seconds", "integer")
      .addColumn("added_at", "text", (c) => c.notNull())
      .execute();
    await db.schema
      .createIndex("playlist_item_order")
      .on("playlist_item")
      .columns(["playlist_id", "position"])
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable("playlist_item").execute();
    await db.schema.dropTable("playlist").execute();
    await db.schema.dropTable("favorite").execute();
  }
};

// Radio presets: favorites gain a stored image (station logo) and a `preset`
// flag. A preset is always a favorite; only radio-kind favorites are promoted.
const m003_favorite_presets: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable("favorite").addColumn("image", "text").execute();
    await db.schema
      .alterTable("favorite")
      .addColumn("preset", "integer", (c) => c.notNull().defaultTo(0))
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable("favorite").dropColumn("preset").execute();
    await db.schema.alterTable("favorite").dropColumn("image").execute();
  }
};

// Per-playlist resume: remember the track a playlist was stopped on (by stable
// source/track identity) so the next "Play all" picks up where it left off.
const m004_playlist_resume: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable("playlist").addColumn("resume_source_id", "text").execute();
    await db.schema.alterTable("playlist").addColumn("resume_track_id", "text").execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable("playlist").dropColumn("resume_track_id").execute();
    await db.schema.alterTable("playlist").dropColumn("resume_source_id").execute();
  }
};

// Recent queues: auto-archive a zone's music queue before a destructive event blows
// it away, keyed by the coordinator's stable zone UUID, for one-tap restore.
const m005_recent_queues: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable("recent_queue")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("coordinator_uuid", "text", (c) => c.notNull())
      .addColumn("title", "text", (c) => c.notNull())
      .addColumn("item_count", "integer", (c) => c.notNull())
      .addColumn("start_track", "integer")
      .addColumn("fingerprint", "text", (c) => c.notNull())
      .addColumn("captured_at", "text", (c) => c.notNull())
      .execute();
    await db.schema
      .createIndex("recent_queue_by_coordinator")
      .on("recent_queue")
      .columns(["coordinator_uuid", "captured_at"])
      .execute();

    await db.schema
      .createTable("recent_queue_item")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("recent_queue_id", "integer", (c) => c.notNull().references("recent_queue.id").onDelete("cascade"))
      .addColumn("position", "integer", (c) => c.notNull())
      .addColumn("source_id", "text", (c) => c.notNull())
      .addColumn("track_id", "text", (c) => c.notNull())
      .addColumn("title", "text", (c) => c.notNull())
      .addColumn("artist", "text")
      .addColumn("album", "text")
      .execute();
    await db.schema
      .createIndex("recent_queue_item_order")
      .on("recent_queue_item")
      .columns(["recent_queue_id", "position"])
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable("recent_queue_item").execute();
    await db.schema.dropTable("recent_queue").execute();
  }
};

const migrations: Record<string, Migration> = {
  "001_init": m001_init,
  "002_library": m002_library,
  "003_favorite_presets": m003_favorite_presets,
  "004_playlist_resume": m004_playlist_resume,
  "005_recent_queues": m005_recent_queues
};

export const migrationProvider: MigrationProvider = {
  getMigrations: async () => migrations
};
