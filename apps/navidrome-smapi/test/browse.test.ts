import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NavidromeBrowser } from "../src/browse.js";
import { SubsonicClient, SubsonicError } from "../src/subsonic.js";

const SERVER = { serverUrl: "http://nd:4533", username: "me", password: "secret" };
const BASE = "http://192.168.1.10:4325";

// A fake Subsonic server: endpoint name → payload merged into an "ok" response.
function fakeFetch(routes: Record<string, unknown>, seen: URL[] = []): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    seen.push(url);
    const endpoint = url.pathname.replace("/rest/", "");
    const payload = routes[endpoint];
    const body = payload === undefined
      ? { "subsonic-response": { status: "failed", error: { code: 70, message: `no route ${endpoint}` } } }
      : { "subsonic-response": { status: "ok", ...(payload as object) } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function browser(routes: Record<string, unknown>, seen?: URL[]): NavidromeBrowser {
  return new NavidromeBrowser(new SubsonicClient(SERVER, fakeFetch(routes, seen)), { transcodeFormat: "mp3" });
}

describe("SubsonicClient", () => {
  it("signs requests with a salted token instead of the password", async () => {
    const seen: URL[] = [];
    const client = new SubsonicClient(SERVER, fakeFetch({ getGenres: { genres: { genre: [] } } }, seen));
    await client.genres();
    const params = seen[0].searchParams;
    expect(params.get("u")).toBe("me");
    expect(params.get("p")).toBeNull();
    expect(params.get("t")).toBe(createHash("md5").update(`secret${params.get("s")}`).digest("hex"));
    expect(params.get("f")).toBe("json");
  });

  it("raises Subsonic errors without leaking the request URL", async () => {
    const client = new SubsonicClient(SERVER, fakeFetch({}));
    const error = await client.song("x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SubsonicError);
    expect((error as SubsonicError).message).toBe("Subsonic getSong: no route getSong");
  });

  it("pages A–Z until a short page", async () => {
    const seen: URL[] = [];
    const page = (count: number) => ({ albumList2: { album: Array.from({ length: count }, (_, i) => ({ id: `a${i}`, name: `A${i}` })) } });
    let call = 0;
    const fetchImpl = (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      seen.push(url);
      const body = { "subsonic-response": { status: "ok", ...page(call++ === 0 ? 500 : 3) } };
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    const albums = await new SubsonicClient(SERVER, fetchImpl).albumList("alphabeticalByName");
    expect(albums).toHaveLength(503);
    expect(seen.map((url) => url.searchParams.get("offset"))).toEqual(["0", "500"]);
  });
});

describe("NavidromeBrowser", () => {
  it("lists the root menu", async () => {
    const result = await browser({}).browse("root", BASE);
    expect(result.items.map((item) => item.title)).toEqual(["Artists", "Albums", "Playlists", "Genres", "Starred"]);
  });

  it("maps an album to playable tracks with art served through this service", async () => {
    const result = await browser({
      getAlbum: {
        album: {
          id: "al1",
          name: "Nemiestny disk",
          song: [{ id: "s1", title: "Prvá", artist: "Band", album: "Nemiestny disk", duration: 181, coverArt: "al-al1", suffix: "opus" }]
        }
      }
    }).browse("al:al1", BASE);
    expect(result.items).toEqual([{
      id: "t:s1",
      title: "Prvá",
      kind: "playable",
      artist: "Band",
      album: "Nemiestny disk",
      durationSeconds: 181,
      albumArtUri: `${BASE}/art?id=al-al1&size=300`
    }]);
  });

  it("orders an artist's albums by year and makes them playable", async () => {
    const result = await browser({
      getArtist: { artist: { id: "ar1", name: "Band", album: [
        { id: "b", name: "Second", year: 2010, artist: "Band" },
        { id: "a", name: "First", year: 2001, artist: "Band" }
      ] } }
    }).browse("ar:ar1", BASE);
    expect(result.items.map((item) => [item.id, item.kind, item.subtitle])).toEqual([
      ["al:a", "album", "Band · 2001"],
      ["al:b", "album", "Band · 2010"]
    ]);
  });

  it("groups search results under section headers", async () => {
    const result = await browser({
      search3: { searchResult3: {
        artist: [{ id: "ar1", name: "Band", albumCount: 1 }],
        song: [{ id: "s1", title: "Prvá" }]
      } }
    }).search("band", BASE);
    expect(result.items.map((item) => `${item.kind}:${item.id}`)).toEqual([
      "section:section:artists",
      "container:ar:ar1",
      "section:section:songs",
      "playable:t:s1"
    ]);
  });

  it("resolves a track to this service's stream endpoint, never a Navidrome URL", async () => {
    const track = await browser({
      getSong: { song: { id: "s1", title: "Prvá", artist: "Band", album: "Disk", duration: 181, suffix: "opus", coverArt: "al-1" } }
    }).track("t:s1", BASE);
    expect(track.url).toBe(`${BASE}/stream?id=s1`);
    expect(track.mimeType).toBe("audio/mpeg");
    expect(track.albumArtUri).toBe(`${BASE}/art?id=al-1&size=300`);
    expect(JSON.stringify(track)).not.toContain("nd:4533");
  });
});
