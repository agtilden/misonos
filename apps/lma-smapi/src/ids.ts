// archive.org identifiers use only [A-Za-z0-9._-] — never ":" — so a colon is a
// safe field separator for our encoded ids.
export type LmaId =
  | { kind: "root" }
  | { kind: "popular" }
  | { kind: "bandsAz" }
  | { kind: "letter"; letter: string }
  | { kind: "band"; bandId: string }
  | { kind: "bandAll"; bandId: string }
  | { kind: "bandYear"; bandId: string; year: string }
  | { kind: "item"; itemId: string }
  | { kind: "track"; itemId: string; fileIndex: number };

const PREFIX = {
  root: "root",
  popular: "popular",
  bandsAz: "az",
  letter: "l",
  band: "b",
  bandAll: "ba",
  bandYear: "by",
  item: "i",
  track: "t"
} as const;

export function encodeId(id: LmaId): string {
  switch (id.kind) {
    case "root": return PREFIX.root;
    case "popular": return PREFIX.popular;
    case "bandsAz": return PREFIX.bandsAz;
    case "letter": return `${PREFIX.letter}:${id.letter}`;
    case "band": return `${PREFIX.band}:${id.bandId}`;
    case "bandAll": return `${PREFIX.bandAll}:${id.bandId}`;
    case "bandYear": return `${PREFIX.bandYear}:${id.bandId}:${id.year}`;
    case "item": return `${PREFIX.item}:${id.itemId}`;
    case "track": return `${PREFIX.track}:${id.itemId}:${id.fileIndex}`;
  }
}

export function decodeId(raw: string): LmaId {
  if (raw === PREFIX.root) return { kind: "root" };
  if (raw === PREFIX.popular) return { kind: "popular" };
  if (raw === PREFIX.bandsAz) return { kind: "bandsAz" };

  const parts = raw.split(":");
  const prefix = parts[0];
  switch (prefix) {
    case PREFIX.letter:
      if (parts.length !== 2) throw new Error(`Bad letter id: ${raw}`);
      return { kind: "letter", letter: parts[1] };
    case PREFIX.band:
      if (parts.length !== 2) throw new Error(`Bad band id: ${raw}`);
      return { kind: "band", bandId: parts[1] };
    case PREFIX.bandAll:
      if (parts.length !== 2) throw new Error(`Bad bandAll id: ${raw}`);
      return { kind: "bandAll", bandId: parts[1] };
    case PREFIX.bandYear:
      if (parts.length !== 3) throw new Error(`Bad bandYear id: ${raw}`);
      return { kind: "bandYear", bandId: parts[1], year: parts[2] };
    case PREFIX.item:
      if (parts.length !== 2) throw new Error(`Bad item id: ${raw}`);
      return { kind: "item", itemId: parts[1] };
    case PREFIX.track: {
      if (parts.length !== 3) throw new Error(`Bad track id: ${raw}`);
      const fileIndex = Number.parseInt(parts[2], 10);
      if (Number.isNaN(fileIndex)) throw new Error(`Bad file index in id: ${raw}`);
      return { kind: "track", itemId: parts[1], fileIndex };
    }
    default:
      throw new Error(`Unknown id: ${raw}`);
  }
}
