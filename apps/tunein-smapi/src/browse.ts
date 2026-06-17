import type { SourceBrowseItem } from "@misonos/sonos-protocol";
import type { TuneInConfig } from "./config.js";
import { encodeId } from "./ids.js";
import { browseRoot as fetchRoot, browseUrl, search, type Outline } from "./tunein.js";
import type { FavoritesStore } from "./store.js";

// Root = pinned stations first, then the TuneIn directory's top-level categories
// (Local Radio / Music / Talk / Sports / By Location / ...).
export async function browseRoot(config: TuneInConfig, store: FavoritesStore): Promise<SourceBrowseItem[]> {
  const items: SourceBrowseItem[] = store.list().map((fav) =>
    stationItem({ guide_id: fav.guideId, text: fav.name, image: fav.image, subtext: fav.subtext })
  );
  for (const outline of await fetchRoot(config)) {
    const item = toItem(outline);
    if (item) items.push(item);
  }
  return items;
}

export async function browseGuide(config: TuneInConfig, url: string): Promise<SourceBrowseItem[]> {
  return flatten(await browseUrl(config, url));
}

export async function searchResults(config: TuneInConfig, query: string): Promise<SourceBrowseItem[]> {
  return flatten(await search(config, query));
}

// Walk the outline tree, flattening bare group headers (no `type`, just
// `children`) so their stations/links surface inline. Drops nodes we can't act
// on (e.g. text-only links with no URL).
function flatten(outlines: Outline[]): SourceBrowseItem[] {
  const items: SourceBrowseItem[] = [];
  for (const outline of outlines) {
    if (outline.children && !outline.type) {
      items.push(...flatten(outline.children));
      continue;
    }
    const item = toItem(outline);
    if (item) items.push(item);
  }
  return items;
}

function toItem(outline: Outline): SourceBrowseItem | null {
  if (outline.type === "audio" && outline.guide_id) return stationItem(outline);
  if (outline.type === "link" && outline.URL) {
    return {
      id: encodeId({ kind: "guide", url: outline.URL }),
      title: outline.text ?? "Untitled",
      kind: "container",
      subtitle: outline.subtext,
      albumArtUri: outline.image
    };
  }
  return null;
}

function stationItem(outline: Pick<Outline, "guide_id" | "text" | "image" | "subtext">): SourceBrowseItem {
  const name = outline.text ?? "Station";
  return {
    id: encodeId({ kind: "station", guideId: outline.guide_id ?? "", name, image: outline.image, subtext: outline.subtext }),
    title: name,
    kind: "playable",
    subtitle: outline.subtext,
    artist: outline.subtext,
    albumArtUri: outline.image
  };
}
