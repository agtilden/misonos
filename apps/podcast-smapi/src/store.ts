import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { PodcastShow } from "./podcastIndex.js";

export interface Subscription extends PodcastShow {
  addedAt: number;
}

interface Row {
  feed_url: string;
  title: string;
  author: string | null;
  image: string | null;
  added_at: number;
}

// Pinned shows. The source owns this state (like grateful-smapi owns its DB); the
// bridge proxies pin/unpin and the root browse lists what's here.
export class SubscriptionStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS podcast_subscriptions (
        feed_url TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT,
        image TEXT,
        added_at INTEGER NOT NULL
      );
    `);
  }

  list(): Subscription[] {
    const rows = this.db.prepare("SELECT * FROM podcast_subscriptions ORDER BY title COLLATE NOCASE").all() as Row[];
    return rows.map((row) => ({
      feedUrl: row.feed_url,
      title: row.title,
      author: row.author ?? undefined,
      image: row.image ?? undefined,
      addedAt: row.added_at
    }));
  }

  has(feedUrl: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM podcast_subscriptions WHERE feed_url = ?").get(feedUrl);
  }

  add(show: PodcastShow): void {
    this.db.prepare(
      `INSERT INTO podcast_subscriptions (feed_url, title, author, image, added_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(feed_url) DO UPDATE SET title = excluded.title, author = excluded.author, image = excluded.image`
    ).run(show.feedUrl, show.title, show.author ?? null, show.image ?? null, Date.now());
  }

  remove(feedUrl: string): void {
    this.db.prepare("DELETE FROM podcast_subscriptions WHERE feed_url = ?").run(feedUrl);
  }
}
