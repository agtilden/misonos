import { describe, expect, it } from "vitest";
import { FavoritesStore } from "../src/store.js";

// In-memory SQLite so each test runs without touching disk.
function freshStore(): FavoritesStore {
  return new FavoritesStore(":memory:");
}

describe("FavoritesStore", () => {
  it("adds, reports, lists, and removes a favorite", () => {
    const store = freshStore();
    const station = { guideId: "s32599", name: "KEXP", subtext: "Seattle", image: "https://img/kexp.jpg" };

    expect(store.has(station.guideId)).toBe(false);
    store.add(station);
    expect(store.has(station.guideId)).toBe(true);

    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ guideId: "s32599", name: "KEXP", subtext: "Seattle", image: "https://img/kexp.jpg" });
    expect(typeof list[0].addedAt).toBe("number");

    store.remove(station.guideId);
    expect(store.has(station.guideId)).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  it("upserts metadata on re-add without duplicating", () => {
    const store = freshStore();
    store.add({ guideId: "s1", name: "Old" });
    store.add({ guideId: "s1", name: "New", subtext: "Now with subtext" });

    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ guideId: "s1", name: "New", subtext: "Now with subtext" });
  });

  it("sorts by name, case-insensitively", () => {
    const store = freshStore();
    store.add({ guideId: "s1", name: "zeta" });
    store.add({ guideId: "s2", name: "Alpha" });
    expect(store.list().map((f) => f.name)).toEqual(["Alpha", "zeta"]);
  });
});
