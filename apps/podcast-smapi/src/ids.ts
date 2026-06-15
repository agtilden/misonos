// Browse ids are self-describing so the source stays stateless about resolution:
// a show carries its feed URL, an episode carries its feed URL + item guid. Both
// payloads are base64url-encoded so arbitrary URLs/guids survive as a single token.

export type PodcastId =
  | { kind: "root" }
  | { kind: "new-episodes" }
  | { kind: "subscriptions" }
  | { kind: "show"; feedUrl: string }
  | { kind: "episode"; feedUrl: string; guid: string };

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function unb64(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

export function encodeId(id: PodcastId): string {
  switch (id.kind) {
    case "root": return "root";
    case "new-episodes": return "new";
    case "subscriptions": return "subs";
    case "show": return `show:${b64(id.feedUrl)}`;
    case "episode": return `ep:${b64(id.feedUrl)}:${b64(id.guid)}`;
  }
}

export function decodeId(raw: string): PodcastId {
  if (raw === "root") return { kind: "root" };
  if (raw === "new") return { kind: "new-episodes" };
  if (raw === "subs") return { kind: "subscriptions" };
  if (raw.startsWith("show:")) return { kind: "show", feedUrl: unb64(raw.slice(5)) };
  if (raw.startsWith("ep:")) {
    const [, feed, guid] = raw.split(":");
    return { kind: "episode", feedUrl: unb64(feed), guid: unb64(guid) };
  }
  throw new Error(`Unknown id: ${raw}`);
}
