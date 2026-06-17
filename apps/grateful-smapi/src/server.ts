import http from "node:http";
import type { SmapiConfig } from "./config.js";
import { resolveMp3Url } from "./archive.js";
import { GratefulDb, trackDurationSeconds, trackUrl } from "./db.js";
import { decodeId, encodeId } from "./ids.js";
import { archiveThumbUrl, browse, dispatch, type BrowseItem } from "./smapi.js";
import { parseSoapRequest, soapFault } from "./soap.js";

export function createServer(config: SmapiConfig): http.Server {
  const db = new GratefulDb(config.dbPath);
  const ctx = { db, catalogVersion: "1" };

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, service: config.serviceName });
      }
      if (request.method === "GET" && url.pathname === "/info") {
        return sendJson(response, 200, {
          id: "grateful-dead-archive",
          name: config.serviceName,
          description: "Live recordings from archive.org",
          rootId: encodeId({ kind: "root" })
        });
      }
      if (request.method === "GET" && url.pathname === "/browse") {
        const rawId = url.searchParams.get("id") ?? encodeId({ kind: "root" });
        try {
          const id = decodeId(rawId);
          const { total, items } = browse(id, ctx);
          return sendJson(response, 200, {
            id: rawId,
            total,
            items: items.map(toSourceItem)
          });
        } catch (error) {
          return sendJson(response, 400, { error: error instanceof Error ? error.message : "Bad id" });
        }
      }
      if (request.method === "GET" && url.pathname === "/track") {
        const rawId = url.searchParams.get("id");
        if (!rawId) return sendJson(response, 400, { error: "Missing id" });
        try {
          const id = decodeId(rawId);
          if (id.kind !== "track") return sendJson(response, 400, { error: "Not a track id" });
          const track = ctx.db.track(id.recordingId, id.trackNumber);
          if (!track) return sendJson(response, 404, { error: "Track not found" });
          if (!track.mp3) return sendJson(response, 404, { error: "Track has no mp3 filename" });
          const resolvedUrl = await resolveMp3Url(track.recordingId, track.mp3, track.trackNumber);
          const playUrl = resolvedUrl ?? trackUrl(track);
          if (!playUrl) return sendJson(response, 404, { error: "Track has no playable URL" });
          return sendJson(response, 200, {
            id: rawId,
            title: track.title || `Track ${track.trackNumber + 1}`,
            artist: "Grateful Dead",
            album: track.date ? `${track.date} — ${track.venueTitle ?? "Unknown venue"}` : track.venueTitle,
            durationSeconds: trackDurationSeconds(track.duration),
            url: playUrl,
            mimeType: "audio/mpeg",
            albumArtUri: track.albumArt || archiveThumbUrl(track.recordingId)
          });
        } catch (error) {
          return sendJson(response, 400, { error: error instanceof Error ? error.message : "Bad id" });
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
        const fault = soapFault("ItemNotFound", error instanceof Error ? error.message : "Bad SOAP envelope");
        respond(response, fault);
        return;
      }

      console.log(`[smapi] ${action}`);
      const result = dispatch(action, parsedBody, ctx);
      respond(response, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal error";
      respond(response, soapFault("ItemNotFound", message));
    }
  });

  server.on("close", () => db.close());
  return server;
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

const EMPTY_PRESENTATION_MAP = `<?xml version="1.0" encoding="UTF-8"?><Presentation></Presentation>`;

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function toSourceItem(item: BrowseItem): { id: string; title: string; kind: "container" | "album" | "playable"; subtitle?: string; artist?: string; album?: string; durationSeconds?: number; albumArtUri?: string } {
  return {
    id: item.id,
    title: item.title,
    kind: item.type === "track" ? "playable" : item.type === "album" ? "album" : "container",
    subtitle: item.album,
    artist: item.artist,
    album: item.album,
    durationSeconds: item.durationSeconds,
    albumArtUri: item.albumArtUri
  };
}
