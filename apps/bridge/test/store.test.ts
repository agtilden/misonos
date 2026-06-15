import { describe, expect, it } from "vitest";
import { createStore } from "../src/store/index.js";

// Uses an in-memory SQLite DB so migrations run and queries execute without
// touching disk. Each test gets a fresh DB.

describe("bridge store", () => {
  it("migrates and round-trips a preference (with upsert)", async () => {
    const store = await createStore(":memory:");
    try {
      expect(await store.getPreference("lastSourceId")).toBeUndefined();
      await store.setPreference("lastSourceId", "ytmusic");
      expect((await store.getPreference("lastSourceId"))?.value).toBe("ytmusic");
      await store.setPreference("lastSourceId", "live-music-archive");
      expect((await store.getPreference("lastSourceId"))?.value).toBe("live-music-archive");
    } finally {
      await store.close();
    }
  });

  it("preserves structured JSON preference values", async () => {
    const store = await createStore(":memory:");
    try {
      await store.setPreference("layout", { columns: 3, dense: true });
      expect((await store.getPreference("layout"))?.value).toEqual({ columns: 3, dense: true });
    } finally {
      await store.close();
    }
  });

  it("dedupes recently-viewed to a single newest row (move-to-top)", async () => {
    const store = await createStore(":memory:");
    try {
      await store.recordRecentlyViewed({ sourceId: "s", itemId: "a", kind: "album", title: "A" });
      await store.recordRecentlyViewed({ sourceId: "s", itemId: "b", kind: "album", title: "B" });
      await store.recordRecentlyViewed({ sourceId: "s", itemId: "a", kind: "album", title: "A2" });
      const rows = await store.listRecentlyViewed("s");
      expect(rows).toHaveLength(2);
      expect(rows[0].itemId).toBe("a");
      expect(rows[0].title).toBe("A2");
    } finally {
      await store.close();
    }
  });

  it("caps recently-viewed at 50 newest", async () => {
    const store = await createStore(":memory:");
    try {
      for (let i = 0; i < 60; i++) {
        await store.recordRecentlyViewed({ sourceId: "s", itemId: `item-${i}`, kind: "playable", title: `T${i}` });
      }
      const rows = await store.listRecentlyViewed("s", 1000);
      expect(rows).toHaveLength(50);
      expect(rows[0].itemId).toBe("item-59"); // newest first
    } finally {
      await store.close();
    }
  });

  it("creates, lists, and deletes an eq preset with boolean loudness", async () => {
    const store = await createStore(":memory:");
    try {
      const preset = await store.createEqPreset({ name: "Late Night", bass: -2, treble: 1, loudness: true });
      expect(preset.id).toBeGreaterThan(0);
      expect(preset.loudness).toBe(true);
      const list = await store.listEqPresets();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe("Late Night");
      expect(list[0].loudness).toBe(true);
      await store.deleteEqPreset(preset.id);
      expect(await store.listEqPresets()).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("clamps eq bass/treble to -10..10", async () => {
    const store = await createStore(":memory:");
    try {
      const preset = await store.createEqPreset({ name: "Hot", bass: 99, treble: -50, loudness: false });
      expect(preset.bass).toBe(10);
      expect(preset.treble).toBe(-10);
      expect(preset.loudness).toBe(false);
    } finally {
      await store.close();
    }
  });

  it("dedupes favorites on (source, item) and refreshes metadata", async () => {
    const store = await createStore(":memory:");
    try {
      await store.addFavorite({ kind: "track", sourceId: "lma", itemId: "t1", title: "Old" });
      await store.addFavorite({ kind: "track", sourceId: "lma", itemId: "t1", title: "New" });
      const favs = await store.listFavorites();
      expect(favs).toHaveLength(1);
      expect(favs[0].title).toBe("New");
      await store.removeFavorite("lma", "t1");
      expect(await store.listFavorites()).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("creates a playlist, appends items, reports itemCount", async () => {
    const store = await createStore(":memory:");
    try {
      const pl = await store.createPlaylist("Mix");
      await store.addPlaylistItems(pl.id, [
        { sourceId: "lma", trackId: "a", title: "A" },
        { sourceId: "lma", trackId: "b", title: "B" },
        { sourceId: "phish-in", trackId: "c", title: "C" }
      ]);
      const loaded = await store.getPlaylist(pl.id);
      expect(loaded?.items.map((i) => i.trackId)).toEqual(["a", "b", "c"]);
      expect(loaded?.items.map((i) => i.position)).toEqual([0, 1, 2]);
      const list = await store.listPlaylists();
      expect(list.find((p) => p.id === pl.id)?.itemCount).toBe(3);
    } finally {
      await store.close();
    }
  });

  it("reorders and removes playlist items keeping positions dense", async () => {
    const store = await createStore(":memory:");
    try {
      const pl = await store.createPlaylist("Mix");
      const items = await store.addPlaylistItems(pl.id, [
        { sourceId: "lma", trackId: "a", title: "A" },
        { sourceId: "lma", trackId: "b", title: "B" },
        { sourceId: "lma", trackId: "c", title: "C" }
      ]);
      const [a, b, c] = items;
      const reordered = await store.reorderPlaylist(pl.id, [c.id, a.id, b.id]);
      expect(reordered.map((i) => i.trackId)).toEqual(["c", "a", "b"]);
      await store.removePlaylistItem(a.id);
      const after = await store.getPlaylist(pl.id);
      expect(after?.items.map((i) => i.trackId)).toEqual(["c", "b"]);
      expect(after?.items.map((i) => i.position)).toEqual([0, 1]);
    } finally {
      await store.close();
    }
  });

  it("cascade-deletes playlist items when the playlist is deleted", async () => {
    const store = await createStore(":memory:");
    try {
      const pl = await store.createPlaylist("Temp");
      await store.addPlaylistItems(pl.id, [{ sourceId: "lma", trackId: "a", title: "A" }]);
      await store.deletePlaylist(pl.id);
      expect(await store.getPlaylist(pl.id)).toBeUndefined();
      expect(await store.listPlaylists()).toHaveLength(0);
    } finally {
      await store.close();
    }
  });
});
