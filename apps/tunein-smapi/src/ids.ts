// Browse ids are self-describing so the source stays stateless about resolution:
// a guide node carries its TuneIn directory URL, a station carries its TuneIn
// guide_id plus the display metadata (name/image/subtext) we already learned at
// browse time — so /track resolves with a single Tune.ashx call and no extra
// metadata lookup. Payloads are base64url-encoded so arbitrary URLs survive as a
// single token.

export interface StationMeta {
  guideId: string;
  name: string;
  image?: string;
  subtext?: string;
}

export type TuneInId =
  | { kind: "root" }
  | { kind: "favorites" }
  | { kind: "guide"; url: string }
  | ({ kind: "station" } & StationMeta);

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function unb64(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

export function encodeId(id: TuneInId): string {
  switch (id.kind) {
    case "root": return "root";
    case "favorites": return "favs";
    case "guide": return `guide:${b64(id.url)}`;
    case "station": {
      // Build the payload field-by-field so the key order (and thus the encoded
      // token) is identical no matter how the id object was assembled — browse
      // items and /subscriptions must produce byte-identical station ids.
      const meta: StationMeta = { guideId: id.guideId, name: id.name, image: id.image, subtext: id.subtext };
      return `station:${b64(JSON.stringify(meta))}`;
    }
  }
}

export function decodeId(raw: string): TuneInId {
  if (raw === "root") return { kind: "root" };
  if (raw === "favs") return { kind: "favorites" };
  if (raw.startsWith("guide:")) return { kind: "guide", url: unb64(raw.slice("guide:".length)) };
  if (raw.startsWith("station:")) {
    const meta = JSON.parse(unb64(raw.slice("station:".length))) as StationMeta;
    return { kind: "station", ...meta };
  }
  throw new Error(`Unknown id: ${raw}`);
}
