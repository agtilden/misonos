import http from "node:http";
import type { SourceBrowseItem, SourceItemKind, SourceTrackInfo } from "@misonos/sonos-protocol";
import { ArchiveClient } from "./archive.js";
import type { LmaConfig } from "./config.js";
import { decodeId, encodeId } from "./ids.js";
import { browse, dispatch, type BrowseItem, type SmapiContext } from "./smapi.js";
import { parseSoapRequest, soapFault } from "./soap.js";

// The bridge/web "source" path doesn't paginate — it expects the whole list in
// one response (like phish/dead do). So when no explicit count is requested we
// return a large window. The biggest single A–Z letter is ~1,600 bands, and the
// per-year recording buckets are smaller, so 2,000 covers them in one request.
// (The native SMAPI path has its own 100 default in smapi.ts; Sonos pages itself.)
const SOURCE_DEFAULT_COUNT = 2000;

export function createServer(config: LmaConfig): http.Server {
  const client = new ArchiveClient(config.collection);
  const ctx: SmapiContext = { client, catalogVersion: "1" };

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, service: config.serviceName });
      }
      if (request.method === "GET" && url.pathname === "/info") {
        return sendJson(response, 200, {
          id: "live-music-archive",
          name: config.serviceName,
          description: `Live concert recordings from archive.org (${config.collection})`,
          rootId: encodeId({ kind: "root" })
        });
      }
      if (request.method === "GET" && url.pathname === "/browse") {
        const rawId = url.searchParams.get("id") ?? encodeId({ kind: "root" });
        const index = intParam(url.searchParams.get("index"), 0);
        const count = intParam(url.searchParams.get("count"), SOURCE_DEFAULT_COUNT);
        try {
          const { total, items } = await browse(decodeId(rawId), index, count, ctx);
          return sendJson(response, 200, { id: rawId, total, items: items.map(toSourceItem) });
        } catch (error) {
          return sendJson(response, 400, { error: errorMessage(error) });
        }
      }
      if (request.method === "GET" && url.pathname === "/track") {
        const rawId = url.searchParams.get("id");
        if (!rawId) return sendJson(response, 400, { error: "Missing id" });
        try {
          return sendJson(response, 200, await trackInfo(rawId, ctx));
        } catch (error) {
          return sendJson(response, 502, { error: errorMessage(error) });
        }
      }
      if (request.method === "GET" && url.pathname.startsWith("/presentationMap")) {
        response.writeHead(200, { "Content-Type": "application/xml" });
        response.end(EMPTY_PRESENTATION_MAP);
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405, { "Content-Type": "text/plain" });
        response.end("Method not allowed");
        return;
      }

      const body = await readBody(request);
      let action = "unknown";
      let parsedBody = "";
      try {
        const parsed = parseSoapRequest(body);
        action = parsed.action;
        parsedBody = parsed.body;
      } catch (error) {
        respond(response, soapFault("ItemNotFound", errorMessage(error)));
        return;
      }

      console.log(`[smapi] ${action}`);
      respond(response, await dispatch(action, parsedBody, ctx));
    } catch (error) {
      respond(response, soapFault("ItemNotFound", errorMessage(error)));
    }
  });
}

async function trackInfo(rawId: string, ctx: SmapiContext): Promise<SourceTrackInfo> {
  const id = decodeId(rawId);
  if (id.kind !== "track") throw new Error("Not a track id");
  const item = await ctx.client.item(id.itemId);
  const track = item.tracks.find((t) => t.fileIndex === id.fileIndex);
  if (!track) throw new Error("Track not found");
  const album = [item.date, item.venue].filter(Boolean).join(" — ");
  return {
    id: rawId,
    title: track.title,
    artist: item.artist,
    album,
    durationSeconds: track.durationSeconds || undefined,
    url: ctx.client.trackUrl(item.id, track.filename),
    mimeType: "audio/mpeg"
  };
}

function toSourceItem(item: BrowseItem): SourceBrowseItem {
  const kind: SourceItemKind = item.type === "track" ? "playable" : item.type === "album" ? "album" : "container";
  return {
    id: item.id,
    title: item.title,
    kind,
    subtitle: item.subtitle ?? item.album,
    artist: item.artist,
    album: item.album,
    durationSeconds: item.durationSeconds
  };
}

function respond(response: http.ServerResponse, payload: { body: string; status: number }): void {
  response.writeHead(payload.status, {
    "Content-Type": "text/xml; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload.body)
  });
  response.end(payload.body);
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    request.on("error", reject);
  });
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

function intParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Internal error";
}

const EMPTY_PRESENTATION_MAP = `<?xml version="1.0" encoding="UTF-8"?><Presentation></Presentation>`;
