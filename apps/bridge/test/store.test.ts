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

  it("promotes a radio favorite to a preset and preserves it across re-favoriting", async () => {
    const store = await createStore(":memory:");
    try {
      await store.addFavorite({ kind: "radio", sourceId: "tunein", itemId: "s1", title: "WNYC", albumArtUri: "http://logo" });
      expect((await store.listFavorites())[0].preset).toBe(false);

      expect(await store.setFavoritePreset("tunein", "s1", true)).toBe(true);
      const promoted = (await store.listFavorites())[0];
      expect(promoted.preset).toBe(true);
      expect(promoted.albumArtUri).toBe("http://logo");

      // Re-favoriting refreshes metadata but must not clear the preset.
      await store.addFavorite({ kind: "radio", sourceId: "tunein", itemId: "s1", title: "WNYC-FM" });
      const after = (await store.listFavorites())[0];
      expect(after.title).toBe("WNYC-FM");
      expect(after.preset).toBe(true);

      // Removing the favorite drops the preset with it.
      await store.removeFavorite("tunein", "s1");
      expect(await store.listFavorites()).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("refuses to make a non-radio favorite a preset", async () => {
    const store = await createStore(":memory:");
    try {
      await store.addFavorite({ kind: "track", sourceId: "ytm", itemId: "v1", title: "A Song" });
      expect(await store.setFavoritePreset("ytm", "v1", true)).toBe(false);
      expect((await store.listFavorites())[0].preset).toBe(false);

      // Promoting a favorite that doesn't exist is likewise rejected.
      expect(await store.setFavoritePreset("ytm", "missing", true)).toBe(false);
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

  it("computes per-playlist resume by stable identity, surviving reorders", async () => {
    const store = await createStore(":memory:");
    try {
      const pl = await store.createPlaylist("Mix");
      const items = await store.addPlaylistItems(pl.id, [
        { sourceId: "lma", trackId: "a", title: "A" },
        { sourceId: "lma", trackId: "b", title: "B" },
        { sourceId: "lma", trackId: "c", title: "C" },
        { sourceId: "lma", trackId: "d", title: "D" }
      ]);
      // No resume saved → play from the top.
      expect((await store.getPlaylist(pl.id))?.playlist.resumeTrackNumber).toBeNull();

      // Stopped on track "c" (index 2) → resume at track 3 (1-based).
      await store.setPlaylistResume(pl.id, "lma", "c");
      expect((await store.getPlaylist(pl.id))?.playlist.resumeTrackNumber).toBe(3);

      // Reorder so "c" moves to the front; resume follows the track, not the slot.
      const [a, b, c, d] = items;
      await store.reorderPlaylist(pl.id, [d.id, c.id, a.id, b.id]);
      // "c" is now index 1 → track 2.
      expect((await store.getPlaylist(pl.id))?.playlist.resumeTrackNumber).toBe(2);

      // Resume at the first or last track means "nothing to resume" → from the top.
      await store.setPlaylistResume(pl.id, "lma", "d"); // d is now index 0
      expect((await store.getPlaylist(pl.id))?.playlist.resumeTrackNumber).toBeNull();
      await store.setPlaylistResume(pl.id, "lma", "b"); // b is now index 3 (last)
      expect((await store.getPlaylist(pl.id))?.playlist.resumeTrackNumber).toBeNull();

      // A removed resume track falls back to the top; clearing does too.
      await store.setPlaylistResume(pl.id, "lma", "a"); // a is index 2 → track 3
      expect((await store.getPlaylist(pl.id))?.playlist.resumeTrackNumber).toBe(3);
      await store.removePlaylistItem(a.id);
      expect((await store.getPlaylist(pl.id))?.playlist.resumeTrackNumber).toBeNull();

      await store.setPlaylistResume(pl.id, "lma", "c");
      await store.clearPlaylistResume(pl.id);
      expect((await store.getPlaylist(pl.id))?.playlist.resumeTrackNumber).toBeNull();
    } finally {
      await store.close();
    }
  });

  it("archives recent queues per coordinator: dedupes, caps at 3, restores refs", async () => {
    const store = await createStore(":memory:");
    try {
      const uuid = "RINCON_AAA";
      const q = (n: string) => ({ items: [{ sourceId: "lma", trackId: `${n}1`, title: `${n} one` }, { sourceId: "lma", trackId: `${n}2`, title: `${n} two` }], startTrack: 2 });

      expect(await store.listRecentQueues(uuid)).toHaveLength(0);

      await store.saveRecentQueue(uuid, q("a"));
      await store.saveRecentQueue(uuid, q("b"));
      // Re-saving an identical queue dedupes (moves to top), not a 3rd row.
      await store.saveRecentQueue(uuid, q("a"));
      const afterDedup = await store.listRecentQueues(uuid);
      expect(afterDedup).toHaveLength(2);
      expect(afterDedup[0].title).toBe("a one"); // most-recent first

      // Cap at 3 newest per coordinator.
      await store.saveRecentQueue(uuid, q("c"));
      await store.saveRecentQueue(uuid, q("d"));
      const capped = await store.listRecentQueues(uuid);
      expect(capped).toHaveLength(3);
      expect(capped.map((r) => r.title)).toEqual(["d one", "c one", "a one"]); // b evicted

      // Restore refs come back in order with the saved start track.
      const refs = await store.getRecentQueueRefs(capped[0].id);
      expect(refs?.items).toEqual([{ sourceId: "lma", trackId: "d1" }, { sourceId: "lma", trackId: "d2" }]);
      expect(refs?.startTrack).toBe(2);

      // Coordinators are isolated; delete removes one.
      await store.saveRecentQueue("RINCON_BBB", q("z"));
      expect(await store.listRecentQueues("RINCON_BBB")).toHaveLength(1);
      await store.deleteRecentQueue(capped[0].id);
      expect(await store.listRecentQueues(uuid)).toHaveLength(2);

      // Empty input is a no-op.
      expect(await store.saveRecentQueue(uuid, { items: [] })).toBeUndefined();
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
