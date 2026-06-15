import http from "node:http";
import type { SourceTrackInfo } from "@misonos/sonos-protocol";
import type { PodcastConfig } from "./config.js";
import { decodeId, encodeId } from "./ids.js";
import { getFeed } from "./feed.js";
import { browseNewEpisodes, browseRoot, browseShow, searchResults } from "./browse.js";
import { SubscriptionStore } from "./store.js";

export function createServer(config: PodcastConfig): http.Server {
  const store = new SubscriptionStore(config.dbPath);

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, service: config.serviceName });
      }
      if (request.method === "GET" && url.pathname === "/info") {
        return sendJson(response, 200, {
          id: "podcasts",
          name: config.serviceName,
          description: "Podcast search and playback via RSS",
          rootId: encodeId({ kind: "root" }),
          capabilities: ["search", "pin"]
        });
      }
      if (request.method === "GET" && url.pathname === "/browse") {
        const rawId = url.searchParams.get("id") ?? encodeId({ kind: "root" });
        const items = await browseId(rawId, store);
        return sendJson(response, 200, { id: rawId, total: items.length, items });
      }
      if (request.method === "GET" && url.pathname === "/search") {
        const query = url.searchParams.get("q") ?? "";
        if (!query.trim()) return sendJson(response, 400, { error: "Missing q" });
        const items = await searchResults(config, query.trim());
        return sendJson(response, 200, { id: `search:${query}`, title: `“${query}”`, total: items.length, items });
      }
      if (request.method === "GET" && url.pathname === "/track") {
        const rawId = url.searchParams.get("id");
        if (!rawId) return sendJson(response, 400, { error: "Missing id" });
        return sendJson(response, 200, await trackInfo(rawId));
      }
      if (request.method === "GET" && url.pathname === "/subscriptions") {
        // Return encoded show ids so the web can match them against browse-item ids.
        return sendJson(response, 200, { ids: store.list().map((sub) => encodeId({ kind: "show", feedUrl: sub.feedUrl })) });
      }
      if (request.method === "POST" && (url.pathname === "/pin" || url.pathname === "/unpin")) {
        const body = await readJson(request);
        const id = typeof body.id === "string" ? body.id : undefined;
        if (!id) return sendJson(response, 400, { error: "Missing id" });
        const decoded = decodeId(id);
        if (decoded.kind !== "show") return sendJson(response, 400, { error: "Not a show id" });
        if (url.pathname === "/unpin") {
          store.remove(decoded.feedUrl);
          return sendJson(response, 200, { pinned: false });
        }
        // Pull channel metadata (cached) so the pinned entry has a title + art.
        const feed = await getFeed(decoded.feedUrl).catch(() => null);
        store.add({ feedUrl: decoded.feedUrl, title: feed?.title ?? decoded.feedUrl, author: feed?.author, image: feed?.image });
        return sendJson(response, 200, { pinned: true });
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Internal error" });
    }
  });
}

async function browseId(rawId: string, store: SubscriptionStore) {
  const id = decodeId(rawId);
  switch (id.kind) {
    case "root":
    case "subscriptions":
      return browseRoot(store);
    case "new-episodes":
      return browseNewEpisodes(store);
    case "show":
      return browseShow(id.feedUrl);
    case "episode":
      throw new Error("Episodes are leaves");
  }
}

async function trackInfo(rawId: string): Promise<SourceTrackInfo> {
  const id = decodeId(rawId);
  if (id.kind !== "episode") throw new Error("Not an episode id");
  const feed = await getFeed(id.feedUrl);
  const episode = feed.episodes.find((ep) => ep.guid === id.guid);
  if (!episode) throw new Error("Episode not found");
  return {
    id: rawId,
    title: episode.title,
    artist: feed.title,
    album: feed.title,
    durationSeconds: episode.durationSeconds,
    albumArtUri: episode.image ?? feed.image,
    url: episode.enclosureUrl,
    mimeType: episode.enclosureType ?? "audio/mpeg"
  };
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}
