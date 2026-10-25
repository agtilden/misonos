import { describe, expect, it } from "vitest";
import { decodeId, encodeId, type NavidromeId } from "../src/ids.js";

describe("navidrome id round-trip", () => {
  const cases: NavidromeId[] = [
    { kind: "root" },
    { kind: "artists" },
    { kind: "albums" },
    { kind: "genres" },
    { kind: "playlists" },
    { kind: "starred" },
    { kind: "albumList", list: "newest" },
    { kind: "albumList", list: "alphabeticalByName" },
    { kind: "artist", artistId: "3a1f" },
    { kind: "album", albumId: "al-9" },
    { kind: "playlist", playlistId: "pl-1" },
    { kind: "genre", genre: "Rock: Classic" },
    { kind: "track", songId: "s-42" }
  ];

  for (const id of cases) {
    it(`survives encode/decode for ${JSON.stringify(id)}`, () => {
      expect(decodeId(encodeId(id))).toEqual(id);
    });
  }

  it("rejects unknown prefixes, unknown album lists and empty ids", () => {
    expect(() => decodeId("nope:whatever")).toThrow();
    expect(() => decodeId("list:bogus")).toThrow();
    expect(() => decodeId("al:")).toThrow();
    expect(() => decodeId("whatever")).toThrow();
  });
});
