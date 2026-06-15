import { describe, expect, it } from "vitest";
import { decodeId, encodeId, type PodcastId } from "../src/ids.js";

describe("podcast id round-trip", () => {
  const cases: PodcastId[] = [
    { kind: "root" },
    { kind: "new-episodes" },
    { kind: "subscriptions" },
    { kind: "show", feedUrl: "https://feeds.example.com/show?id=abc&x=1" },
    { kind: "episode", feedUrl: "https://feeds.example.com/rss.xml", guid: "tag:example.com,2024:/episode/42" }
  ];

  for (const id of cases) {
    it(`survives encode/decode for ${id.kind}`, () => {
      expect(decodeId(encodeId(id))).toEqual(id);
    });
  }

  it("preserves a guid that is itself a URL with colons", () => {
    const id: PodcastId = { kind: "episode", feedUrl: "https://a.com/f.xml", guid: "https://a.com/ep/1:2:3" };
    expect(decodeId(encodeId(id))).toEqual(id);
  });

  it("rejects unknown ids", () => {
    expect(() => decodeId("nope:whatever")).toThrow();
  });
});
