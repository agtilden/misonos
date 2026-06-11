import type { QueueItem } from "./types.js";
import { allTagBlocks, attrText, decodeXmlEntities, tagText } from "./xml.js";

function absolutizeAlbumArt(uri: string | undefined, speakerBaseUrl?: string): string | undefined {
  if (!uri) return undefined;
  if (/^https?:\/\//i.test(uri)) return uri;
  if (!speakerBaseUrl) return uri;
  return `${speakerBaseUrl}${uri.startsWith("/") ? "" : "/"}${uri}`;
}

function parseDidlBlock(block: string, speakerBaseUrl?: string): QueueItem {
  return {
    id: attrText(block, "id") ?? cryptoSafeId(block),
    parentId: attrText(block, "parentID"),
    title: tagText(block, "dc:title") ?? tagText(block, "title") ?? "Untitled",
    artist: tagText(block, "dc:creator") ?? tagText(block, "upnp:artist"),
    album: tagText(block, "upnp:album"),
    albumArtUri: absolutizeAlbumArt(tagText(block, "upnp:albumArtURI"), speakerBaseUrl),
    uri: tagText(block, "res"),
    itemClass: tagText(block, "upnp:class")
  };
}

export function parseDidlItems(didlXml: string | undefined, speakerBaseUrl?: string): QueueItem[] {
  if (!didlXml || didlXml === "NOT_IMPLEMENTED") return [];
  const xml = decodeXmlEntities(didlXml);
  return [...allTagBlocks(xml, "item"), ...allTagBlocks(xml, "container")].map((block) =>
    parseDidlBlock(block, speakerBaseUrl)
  );
}

export function firstDidlItem(didlXml: string | undefined, speakerBaseUrl?: string): QueueItem | undefined {
  return parseDidlItems(didlXml, speakerBaseUrl)[0];
}

function cryptoSafeId(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return `item-${hash.toString(16)}`;
}
