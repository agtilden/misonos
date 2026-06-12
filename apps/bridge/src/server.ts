import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { BridgeEvent, TransportAction, VolumePayload } from "@misonos/sonos-protocol";
import type { BridgeConfig } from "./config.js";
import { SonosEventManager } from "./sonosEvents.js";
import { SonosService } from "./sonosService.js";
import { proxyStream } from "./streamProxy.js";

type RouteHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) => Promise<void>;

export function createServer(service: SonosService, config: BridgeConfig): http.Server {
  const clients = new Set<ServerResponse>();
  const sonosEvents = new SonosEventManager(config);

  const sendEvent = (event: BridgeEvent) => {
    for (const client of clients) {
      client.write(`event: ${event.type}\n`);
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };

  service.onSnapshot = (snapshot) => {
    void ensureSonosSubscriptions(snapshot);
    sendEvent({ type: "snapshot", payload: snapshot, at: new Date().toISOString() });
  };

  setInterval(async () => {
    if (clients.size === 0) return;
    try {
      const snapshot = await service.snapshot();
      await ensureSonosSubscriptions(snapshot);
      sendEvent({ type: "snapshot", payload: snapshot, at: new Date().toISOString() });
    } catch (error) {
      sendEvent({ type: "error", message: errorMessage(error), at: new Date().toISOString() });
    }
  }, config.pollIntervalMs).unref();

  const routes: RouteHandler = async (request, response, url) => {
    if (request.method === "NOTIFY" && url.pathname === "/api/sonos-events") {
      const notify = sonosEvents.handleNotify(request.headers, await readText(request));
      empty(response, 200);
      void handleSonosNotify(notify.groupId, notify.serviceType);
      return;
    }
    if (request.method === "OPTIONS") return empty(response, 204);
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, { ok: true, name: "misonos-bridge" });
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      });
      clients.add(response);
      response.write(`event: connected\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
      request.on("close", () => clients.delete(response));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/discover") {
      const snapshot = await service.discover();
      await ensureSonosSubscriptions(snapshot);
      sendEvent({ type: "snapshot", payload: snapshot, at: new Date().toISOString() });
      return json(response, snapshot);
    }
    if (request.method === "GET" && url.pathname === "/api/zones") {
      return json(response, (await service.snapshot()).zones);
    }
    if (request.method === "GET" && url.pathname === "/api/groups") {
      const snapshot = await service.snapshot();
      await ensureSonosSubscriptions(snapshot);
      return json(response, snapshot.groups);
    }

    const nowPlayingMatch = url.pathname.match(/^\/api\/groups\/([^/]+)\/now-playing$/);
    if (request.method === "GET" && nowPlayingMatch) {
      return json(response, await service.nowPlaying(decodeURIComponent(nowPlayingMatch[1])));
    }

    const queueMatch = url.pathname.match(/^\/api\/groups\/([^/]+)\/queue$/);
    if (request.method === "GET" && queueMatch) {
      return json(response, await service.queue(decodeURIComponent(queueMatch[1])));
    }

    const transportMatch = url.pathname.match(/^\/api\/groups\/([^/]+)\/transport$/);
    if (request.method === "POST" && transportMatch) {
      const body = await readJson<{ action: TransportAction }>(request);
      if (!isTransportAction(body.action)) return json(response, { error: "Invalid transport action" }, 400);
      const nowPlaying = await service.transport(decodeURIComponent(transportMatch[1]), body.action);
      sendEvent({ type: "now-playing", payload: nowPlaying, at: new Date().toISOString() });
      return json(response, nowPlaying);
    }

    const playIndexMatch = url.pathname.match(/^\/api\/groups\/([^/]+)\/queue\/play-index$/);
    if (request.method === "POST" && playIndexMatch) {
      const body = await readJson<{ index: number }>(request);
      if (!Number.isInteger(body.index) || body.index < 1) return json(response, { error: "Invalid queue index" }, 400);
      const nowPlaying = await service.playQueueIndex(decodeURIComponent(playIndexMatch[1]), body.index);
      sendEvent({ type: "now-playing", payload: nowPlaying, at: new Date().toISOString() });
      return json(response, nowPlaying);
    }

    const seekMatch = url.pathname.match(/^\/api\/groups\/([^/]+)\/seek$/);
    if (request.method === "POST" && seekMatch) {
      const body = await readJson<{ positionSeconds: number }>(request);
      if (typeof body.positionSeconds !== "number" || body.positionSeconds < 0) return json(response, { error: "Invalid position" }, 400);
      const nowPlaying = await service.seekToPosition(decodeURIComponent(seekMatch[1]), body.positionSeconds);
      sendEvent({ type: "now-playing", payload: nowPlaying, at: new Date().toISOString() });
      return json(response, nowPlaying);
    }

    const groupVolumeMatch = url.pathname.match(/^\/api\/groups\/([^/]+)\/volume$/);
    if (groupVolumeMatch) {
      const groupId = decodeURIComponent(groupVolumeMatch[1]);
      if (request.method === "GET") return json(response, await service.groupVolume(groupId));
      if (request.method === "POST") return json(response, await service.setGroupVolume(groupId, await readJson<VolumePayload>(request)));
    }

    const joinZoneMatch = url.pathname.match(/^\/api\/zones\/([^/]+)\/join$/);
    if (request.method === "POST" && joinZoneMatch) {
      const body = await readJson<{ groupId: string }>(request);
      if (!body.groupId) return json(response, { error: "Missing groupId" }, 400);
      const snapshot = await service.joinZoneToGroup(decodeURIComponent(joinZoneMatch[1]), body.groupId);
      await ensureSonosSubscriptions(snapshot);
      sendEvent({ type: "snapshot", payload: snapshot, at: new Date().toISOString() });
      return json(response, snapshot);
    }

    const promoteZoneMatch = url.pathname.match(/^\/api\/zones\/([^/]+)\/promote$/);
    if (request.method === "POST" && promoteZoneMatch) {
      const snapshot = await service.promoteZoneToCoordinator(decodeURIComponent(promoteZoneMatch[1]));
      await ensureSonosSubscriptions(snapshot);
      sendEvent({ type: "snapshot", payload: snapshot, at: new Date().toISOString() });
      return json(response, snapshot);
    }

    const standaloneZoneMatch = url.pathname.match(/^\/api\/zones\/([^/]+)\/standalone$/);
    if (request.method === "POST" && standaloneZoneMatch) {
      const snapshot = await service.makeZoneStandalone(decodeURIComponent(standaloneZoneMatch[1]));
      await ensureSonosSubscriptions(snapshot);
      sendEvent({ type: "snapshot", payload: snapshot, at: new Date().toISOString() });
      return json(response, snapshot);
    }

    const volumeMatch = url.pathname.match(/^\/api\/zones\/([^/]+)\/volume$/);
    if (volumeMatch) {
      const zoneId = decodeURIComponent(volumeMatch[1]);
      if (request.method === "GET") return json(response, await service.zoneVolume(zoneId));
      if (request.method === "POST") return json(response, await service.setVolume(zoneId, await readJson<VolumePayload>(request)));
    }

    if (request.method === "GET" && url.pathname === "/api/devices") {
      return json(response, await service.listDevices());
    }

    if (request.method === "GET" && url.pathname === "/api/sources") {
      return json(response, await service.listSources());
    }

    const streamMatch = url.pathname.match(/^\/api\/stream\/([^/]+)\/([^/]+?)(?:\.[A-Za-z0-9]{2,5})?(?:\/[^/]+)?$/);
    if (streamMatch && (request.method === "GET" || request.method === "HEAD")) {
      console.log(`[stream] ${request.socket.remoteAddress} ${request.method} ${request.url} range=${request.headers.range ?? "-"}`);
      const sourceId = decodeURIComponent(streamMatch[1]);
      const trackId = decodeURIComponent(streamMatch[2]);
      await proxyStream(sourceId, trackId, request, response);
      return;
    }

    const sourceBrowseMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/browse$/);
    if (request.method === "GET" && sourceBrowseMatch) {
      const sourceId = decodeURIComponent(sourceBrowseMatch[1]);
      const id = url.searchParams.get("id") ?? undefined;
      return json(response, await service.browseSource(sourceId, id));
    }

    const sourceSearchMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/search$/);
    if (request.method === "GET" && sourceSearchMatch) {
      const sourceId = decodeURIComponent(sourceSearchMatch[1]);
      const query = url.searchParams.get("q") ?? "";
      const type = url.searchParams.get("type") ?? undefined;
      if (!query) return json(response, { error: "Missing q" }, 400);
      return json(response, await service.searchSource(sourceId, query, type));
    }

    const sourceAuthStatusMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/auth\/status$/);
    if (request.method === "GET" && sourceAuthStatusMatch) {
      return json(response, await service.sourceAuthStatus(decodeURIComponent(sourceAuthStatusMatch[1])));
    }

    const sourceAuthStartMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/auth\/start$/);
    if (request.method === "POST" && sourceAuthStartMatch) {
      return json(response, await service.sourceAuthStart(decodeURIComponent(sourceAuthStartMatch[1])));
    }

    const sourceAuthSignOutMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/auth\/signout$/);
    if (request.method === "POST" && sourceAuthSignOutMatch) {
      return json(response, await service.sourceAuthSignOut(decodeURIComponent(sourceAuthSignOutMatch[1])));
    }

    const sourceTrackMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/track$/);
    if (request.method === "GET" && sourceTrackMatch) {
      const sourceId = decodeURIComponent(sourceTrackMatch[1]);
      const id = url.searchParams.get("id");
      if (!id) return json(response, { error: "Missing id" }, 400);
      return json(response, await service.fetchSourceTrack(sourceId, id));
    }

    const sourcePlayMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/play$/);
    if (request.method === "POST" && sourcePlayMatch) {
      const sourceId = decodeURIComponent(sourcePlayMatch[1]);
      const body = await readJson<{ trackIds: string[]; groupId: string; mode?: "replace" | "next" | "end" }>(request);
      if (!Array.isArray(body.trackIds) || body.trackIds.length === 0) return json(response, { error: "trackIds[] is required" }, 400);
      if (!body.groupId) return json(response, { error: "Missing groupId" }, 400);
      const mode = body.mode ?? "replace";
      const nowPlaying = await service.playSourceItems({ sourceId, trackIds: body.trackIds, groupId: body.groupId, mode });
      return json(response, nowPlaying);
    }

    if (request.method === "GET" && url.pathname === "/api/music/services") {
      return json(response, await service.listMusicServices());
    }

    if (request.method === "GET" && url.pathname === "/api/music/custom-presets") {
      return json(response, service.listCustomServicePresets());
    }

    if (request.method === "POST" && url.pathname === "/api/music/custom-presets/register") {
      const body = await readJson<{ presetId: string; zoneId: string; hostOverride?: string; uriOverride?: string; secureUri?: string }>(request);
      if (!body.presetId || !body.zoneId) return json(response, { error: "Missing presetId or zoneId" }, 400);
      return json(response, await service.registerCustomServiceOnZone(body));
    }

    if (request.method === "GET" && url.pathname === "/api/music/accounts") {
      return json(response, await service.listSonosAccounts());
    }

    if (request.method === "POST" && url.pathname === "/api/debug/smapi-sn-scan") {
      const body = await readJson<{
        sourceId?: string;
        groupId?: string;
        trackId?: string;
        sid?: number;
        serviceTokenMagic?: number;
        flags?: number;
        startSn?: number;
        endSn?: number;
        ext?: string;
        uriScheme?: "x-sonos-http" | "x-sonosapi-stream";
        descMode?: "anonymous" | "token";
        refreshServices?: boolean;
        playOnSuccess?: boolean;
        clearQueueBeforeEach?: boolean;
        stopAfterPlay?: boolean;
      }>(request);
      return json(response, await service.scanSmapiAccountIndices(body));
    }

    if (request.method === "POST" && url.pathname === "/api/music/browse") {
      const body = await readJson<{ objectId: string; startingIndex?: number; requestedCount?: number; filter?: string; sortCriteria?: string }>(request);
      if (!body.objectId) return json(response, { error: "Missing objectId" }, 400);
      return json(response, await service.browseContainer(body));
    }

    if (request.method === "POST" && url.pathname === "/api/music/search") {
      const body = await readJson<{ containerId: string; searchCriteria: string; startingIndex?: number; requestedCount?: number; filter?: string; sortCriteria?: string }>(request);
      if (!body.containerId || !body.searchCriteria) return json(response, { error: "Missing containerId or searchCriteria" }, 400);
      return json(response, await service.searchContainer(body));
    }

    return json(response, { error: "Not found" }, 404);
  };

  const server = http.createServer(async (request, response) => {
    try {
      await routes(request, response, new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`));
    } catch (error) {
      console.error(`[bridge] ${request.method} ${request.url} failed:`, error instanceof Error ? error.message : error);
      if (error instanceof Error && error.stack) console.error(error.stack);
      json(response, { error: errorMessage(error) }, 500);
    }
  });
  server.on("close", () => sonosEvents.unsubscribeAll());
  return server;

  async function ensureSonosSubscriptions(snapshot: Awaited<ReturnType<SonosService["snapshot"]>>): Promise<void> {
    try {
      await sonosEvents.ensureSnapshotSubscriptions(snapshot);
    } catch (error) {
      sendEvent({ type: "error", message: errorMessage(error), at: new Date().toISOString() });
    }
  }

  async function handleSonosNotify(groupId?: string, serviceType?: string): Promise<void> {
    try {
      if (serviceType === "ZoneGroupTopology") {
        const snapshot = await service.discover();
        await ensureSonosSubscriptions(snapshot);
        sendEvent({ type: "snapshot", payload: snapshot, at: new Date().toISOString() });
        return;
      }
      if (groupId) {
        const nowPlaying = await service.nowPlayingSettled(groupId);
        sendEvent({ type: "now-playing", payload: nowPlaying, at: new Date().toISOString() });
      }
    } catch (error) {
      sendEvent({ type: "error", message: errorMessage(error), at: new Date().toISOString() });
    }
  }
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, {
    ...corsHeaders(),
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

function empty(response: ServerResponse, status = 204): void {
  response.writeHead(status, corsHeaders());
  response.end();
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const raw = await readText(request);
  return (raw ? JSON.parse(raw) : {}) as T;
}

async function readText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown bridge error";
}

function isTransportAction(value: unknown): value is TransportAction {
  return value === "play" || value === "pause" || value === "stop" || value === "next" || value === "previous";
}
