import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { StationMeta } from "./ids.js";

export interface Favorite extends StationMeta {
  addedAt: number;
}

interface Row {
  guide_id: string;
  name: string;
  subtext: string | null;
  image: string | null;
  added_at: number;
}

// Pinned (favorited) stations. The source owns this state (like grateful-smapi
// owns its DB); the bridge proxies pin/unpin and the root browse lists what's here.
export class FavoritesStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tunein_favorites (
        guide_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        subtext TEXT,
        image TEXT,
        added_at INTEGER NOT NULL
      );
    `);
  }

  list(): Favorite[] {
    const rows = this.db.prepare("SELECT * FROM tunein_favorites ORDER BY name COLLATE NOCASE").all() as Row[];
    return rows.map((row) => ({
      guideId: row.guide_id,
      name: row.name,
      subtext: row.subtext ?? undefined,
      image: row.image ?? undefined,
      addedAt: row.added_at
    }));
  }

  has(guideId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM tunein_favorites WHERE guide_id = ?").get(guideId);
  }

  add(station: StationMeta): void {
    this.db.prepare(
      `INSERT INTO tunein_favorites (guide_id, name, subtext, image, added_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(guide_id) DO UPDATE SET name = excluded.name, subtext = excluded.subtext, image = excluded.image`
    ).run(station.guideId, station.name, station.subtext ?? null, station.image ?? null, Date.now());
  }

  remove(guideId: string): void {
    this.db.prepare("DELETE FROM tunein_favorites WHERE guide_id = ?").run(guideId);
  }
}
