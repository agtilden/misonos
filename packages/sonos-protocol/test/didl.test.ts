import { describe, expect, it } from "vitest";
import { firstDidlItem, parseDidlItems } from "../src/didl.js";

describe("DIDL parsing", () => {
  const didl = `<DIDL-Lite><item id="Q:0/1" parentID="Q:0"><dc:title>Track One</dc:title><dc:creator>Artist</dc:creator><upnp:album>Album</upnp:album><upnp:albumArtURI>/getaa?s=1</upnp:albumArtURI><res>x-file-cifs://track.mp3</res></item></DIDL-Lite>`;

  it("parses queue items", () => {
    expect(parseDidlItems(didl, "http://192.168.1.2:1400")).toEqual([
      {
        id: "Q:0/1",
        parentId: "Q:0",
        title: "Track One",
        artist: "Artist",
        album: "Album",
        albumArtUri: "http://192.168.1.2:1400/getaa?s=1",
        uri: "x-file-cifs://track.mp3",
        itemClass: undefined
      }
    ]);
  });

  it("returns the first item", () => {
    expect(firstDidlItem(didl)?.title).toBe("Track One");
  });
});
