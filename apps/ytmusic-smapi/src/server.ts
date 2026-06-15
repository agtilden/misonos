import http from "node:http";
import type { SourceBrowseItem, SourceBrowseResponse, SourceTrackInfo } from "@misonos/sonos-protocol";
import type { YtmConfig } from "./config.js";
import { getClient, getStreamUrl } from "./client.js";
import { getTrackInfo } from "./ytmApi.js";
import { decodeId, encodeId } from "./ids.js";
import { browse as runBrowse, runSearch as runTypedSearch } from "./browse.js";
import { currentStatus, signOut, startSignIn } from "./auth.js";
import { clearCookies, cookieAuthStatus, setCookiesFromPaste } from "./cookieAuth.js";
import { dispatch as smapiDispatch } from "./smapi.js";
import { parseSoapRequest, soapFault } from "./soap.js";

export function createServer(config: YtmConfig): http.Server {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, service: config.serviceName });
      }
      if (request.method === "GET" && url.pathname === "/info") {
        return sendJson(response, 200, {
          id: "youtube-music",
          name: config.serviceName,
          description: "YouTube Music search and playback",
          rootId: encodeId({ kind: "root" }),
          capabilities: ["search"]
        });
      }
      if (request.method === "GET" && url.pathname === "/browse") {
        const rawId = url.searchParams.get("id") ?? encodeId({ kind: "root" });
        return sendJson(response, 200, await runBrowse(rawId));
      }
      if (request.method === "GET" && url.pathname === "/search") {
        const query = url.searchParams.get("q") ?? "";
        const type = (url.searchParams.get("type") ?? "song") as "song" | "artist" | "album";
        if (!query) return sendJson(response, 400, { error: "Missing q" });
        return sendJson(response, 200, await runSearchResponse(query, type));
      }
      if (request.method === "GET" && url.pathname === "/track") {
        const rawId = url.searchParams.get("id");
        if (!rawId) return sendJson(response, 400, { error: "Missing id" });
        return sendJson(response, 200, await resolveTrack(rawId));
      }
      if (request.method === "GET" && url.pathname === "/auth/status") {
        await getClient();
        // Merge the OAuth state with the pasted-cookie state so the UI can show both.
        return sendJson(response, 200, { ...currentStatus(), ...cookieAuthStatus() });
      }
      if (request.method === "POST" && url.pathname === "/auth/cookies") {
        const raw = await readBody(request);
        try {
          return sendJson(response, 200, { ...currentStatus(), ...(await setCookiesFromPaste(raw)) });
        } catch (error) {
          return sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid paste" });
        }
      }
      if (request.method === "POST" && url.pathname === "/auth/cookies/clear") {
        return sendJson(response, 200, { ...currentStatus(), ...(await clearCookies()) });
      }
      if (request.method === "POST" && url.pathname === "/auth/start") {
        const yt = await getClient();
        return sendJson(response, 200, startSignIn(yt));
      }
      if (request.method === "POST" && url.pathname === "/auth/signout") {
        const yt = await getClient();
        await signOut(yt);
        return sendJson(response, 200, currentStatus());
      }
      if (request.method === "POST" && (url.pathname === "/" || url.pathname === "/smapi")) {
        const raw = await readBody(request);
        try {
          const parsed = parseSoapRequest(raw);
          console.log(`[smapi] ${parsed.action} from ${request.socket.remoteAddress}`);
          const result = await smapiDispatch(parsed.action, parsed.body);
          return respondSoap(response, result);
        } catch (error) {
          const fault = soapFault("ItemNotFound", error instanceof Error ? error.message : "Bad SOAP envelope");
          return respondSoap(response, fault);
        }
      }
      if (request.method === "GET" && url.pathname.startsWith("/presentationMap")) {
        response.writeHead(200, { "Content-Type": "application/xml" });
        response.end(`<?xml version="1.0" encoding="UTF-8"?><Presentation></Presentation>`);
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const status = error instanceof Error && error.message.startsWith("Bad ") ? 400 : 500;
      sendJson(response, status, { error: error instanceof Error ? error.message : "Internal error" });
    }
  });
}

async function runSearchResponse(query: string, type: "song" | "artist" | "album"): Promise<SourceBrowseResponse> {
  const items = await runTypedSearch(query, type);
  return {
    id: encodeId({ kind: "search", query }),
    title: `“${query}”`,
    total: items.length,
    items: items as SourceBrowseItem[]
  };
}

async function resolveTrack(rawId: string): Promise<SourceTrackInfo> {
  const id = decodeId(rawId);
  if (id.kind !== "track") throw new Error("Bad id for track");
  const [meta, stream] = await Promise.all([
    getTrackInfo(id.videoId),
    getStreamUrl(id.videoId)
  ]);
  return {
    id: rawId,
    title: meta?.title ?? id.videoId,
    artist: meta?.artist,
    album: meta?.album,
    durationSeconds: meta?.durationSeconds,
    albumArtUri: meta?.thumbnailUrl,
    url: stream.url,
    mimeType: stream.mimeType ?? "audio/mp4"
  };
}

function respondSoap(response: http.ServerResponse, payload: { body: string; status: number }): void {
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
