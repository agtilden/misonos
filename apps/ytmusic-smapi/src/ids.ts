export type YtmId =
  | { kind: "root" }
  | { kind: "search"; query: string }
  | { kind: "track"; videoId: string };

export function encodeId(id: YtmId): string {
  switch (id.kind) {
    case "root": return "root";
    case "search": return `search:${id.query}`;
    case "track": return `t:${id.videoId}`;
  }
}

export function decodeId(raw: string): YtmId {
  if (raw === "root") return { kind: "root" };
  if (raw.startsWith("search:")) return { kind: "search", query: raw.slice(7) };
  if (raw.startsWith("t:")) return { kind: "track", videoId: raw.slice(2) };
  throw new Error(`Unknown id: ${raw}`);
}
