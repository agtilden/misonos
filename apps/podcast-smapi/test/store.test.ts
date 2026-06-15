import { describe, expect, it } from "vitest";
import { SubscriptionStore } from "../src/store.js";

// In-memory SQLite so each test runs without touching disk.
function freshStore(): SubscriptionStore {
  return new SubscriptionStore(":memory:");
}

describe("SubscriptionStore", () => {
  it("adds, reports, lists, and removes a subscription", () => {
    const store = freshStore();
    const show = { feedUrl: "https://feeds.example.com/a.xml", title: "Show A", author: "Auth", image: "https://img/a.jpg" };

    expect(store.has(show.feedUrl)).toBe(false);
    store.add(show);
    expect(store.has(show.feedUrl)).toBe(true);

    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ feedUrl: show.feedUrl, title: "Show A", author: "Auth", image: "https://img/a.jpg" });
    expect(typeof list[0].addedAt).toBe("number");

    store.remove(show.feedUrl);
    expect(store.has(show.feedUrl)).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  it("upserts metadata on re-add without duplicating", () => {
    const store = freshStore();
    store.add({ feedUrl: "https://feeds.example.com/b.xml", title: "Old" });
    store.add({ feedUrl: "https://feeds.example.com/b.xml", title: "New", author: "X" });
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("New");
    expect(list[0].author).toBe("X");
  });

  it("lists alphabetically by title", () => {
    const store = freshStore();
    store.add({ feedUrl: "https://f/2", title: "Banana" });
    store.add({ feedUrl: "https://f/1", title: "apple" });
    expect(store.list().map((s) => s.title)).toEqual(["apple", "Banana"]);
  });
});
