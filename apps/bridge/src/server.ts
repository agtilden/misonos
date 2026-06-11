import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { BridgeEvent, TransportAction, VolumePayload } from "@misonos/sonos-protocol";
import type { BridgeConfig } from "./config.js";
import { SonosEventManager } from "./sonosEvents.js";
import { SonosService } from "./sonosService.js";

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

    return json(response, { error: "Not found" }, 404);
  };

  const server = http.createServer(async (request, response) => {
    try {
      await routes(request, response, new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`));
    } catch (error) {
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
