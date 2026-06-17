import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { AlarmInput, BridgeEvent, EqPayload, EqPreset, Favorite, PlaybackMode, RecentlyViewedItem, RepeatMode, SourceItemKind, TransportAction, VolumePayload } from "@misonos/sonos-protocol";
import type { BridgeConfig } from "./config.js";
import { SonosEventManager } from "./sonosEvents.js";
import { SonosService } from "./sonosService.js";
import type { Store } from "./store/index.js";
import { proxyStream } from "./streamProxy.js";
import { serveArt } from "./artProxy.js";
import { deleteSourceIcon, listSourceIcons, saveSourceIcon, serveSourceIcon } from "./sourceIcons.js";
import path from "node:path";

type RouteHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) => Promise<void>;

export function createServer(service: SonosService, config: BridgeConfig, store: Store): http.Server {
  const clients = new Set<ServerResponse>();
  const sonosEvents = new SonosEventManager(config);
  const artCacheDir = path.join(path.dirname(config.dbPath), "art-cache");
  const sourceIconsDir = path.join(path.dirname(config.dbPath), "source-icons");

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
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/api/art") {
      if (!url.searchParams.get("u") && !url.searchParams.get("artist") && !url.searchParams.get("fallback")) {
        return json(response, { error: "Missing art descriptor" }, 400);
      }
      await serveArt(url.searchParams, request, response, artCacheDir);
      return;
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

    const queueRemoveMatch = url.pathname.match(/^\/api\/groups\/([^/]+)\/queue\/remove$/);
    if (request.method === "POST" && queueRemoveMatch) {
      const body = await readJson<{ index: number }>(request);
      if (!Number.isInteger(body.index) || body.index < 0) return json(response, { error: "Invalid queue index" }, 400);
      return json(response, await service.removeQueueTrack(decodeURIComponent(queueRemoveMatch[1]), body.index));
    }

    const seekMatch = url.pathname.match(/^\/api\/groups\/([^/]+)\/seek$/);
    if (request.method === "POST" && seekMatch) {
      const body = await readJson<{ positionSeconds: number }>(request);
      if (typeof body.positionSeconds !== "number" || body.positionSeconds < 0) return json(response, { error: "Invalid position" }, 400);
      const nowPlaying = await service.seekToPosition(decodeURIComponent(seekMatch[1]), body.positionSeconds);
      sendEvent({ type: "now-playing", payload: nowPlaying, at: new Date().toISOString() });
      return json(response, nowPlaying);
    }

    const playModeMatch = url.pathname.match(/^\/api\/groups\/([^/]+)\/play-mode$/);
    if (request.method === "POST" && playModeMatch) {
      const body = await readJson<{ repeat: RepeatMode; shuffle: boolean }>(request);
      if (body.repeat !== "none" && body.repeat !== "all" && body.repeat !== "one") return json(response, { error: "Invalid repeat" }, 400);
      const nowPlaying = await service.setPlaybackMode(decodeURIComponent(playModeMatch[1]), body.repeat, !!body.shuffle);
      sendEvent({ type: "now-playing", payload: nowPlaying, at: new Date().toISOString() });
      return json(response, nowPlaying);
    }

    const crossfadeMatch = url.pathname.match(/^\/api\/groups\/([^/]+)\/crossfade$/);
    if (request.method === "POST" && crossfadeMatch) {
      const body = await readJson<{ enabled: boolean }>(request);
      const nowPlaying = await service.setCrossfade(decodeURIComponent(crossfadeMatch[1]), !!body.enabled);
      sendEvent({ type: "now-playing", payload: nowPlaying, at: new Date().toISOString() });
      return json(response, nowPlaying);
    }

    const sleepTimerMatch = url.pathname.match(/^\/api\/groups\/([^/]+)\/sleep-timer$/);
    if (request.method === "POST" && sleepTimerMatch) {
      const body = await readJson<{ seconds: number }>(request);
      if (typeof body.seconds !== "number" || body.seconds < 0) return json(response, { error: "Invalid seconds" }, 400);
      const nowPlaying = await service.setSleepTimer(decodeURIComponent(sleepTimerMatch[1]), body.seconds);
      sendEvent({ type: "now-playing", payload: nowPlaying, at: new Date().toISOString() });
      return json(response, nowPlaying);
    }

    // --- Alarms (household-wide; POST-only writes) ---
    if (url.pathname === "/api/alarms") {
      if (request.method === "GET") return json(response, await service.listAlarms());
      if (request.method === "POST") {
        const body = await readJson<AlarmInput>(request);
        const invalid = validateAlarmInput(body);
        if (invalid) return json(response, { error: invalid }, 400);
        return json(response, await service.createAlarm(body), 201);
      }
    }

    const alarmDeleteMatch = url.pathname.match(/^\/api\/alarms\/([^/]+)\/delete$/);
    if (request.method === "POST" && alarmDeleteMatch) {
      return json(response, await service.deleteAlarm(decodeURIComponent(alarmDeleteMatch[1])));
    }

    const alarmUpdateMatch = url.pathname.match(/^\/api\/alarms\/([^/]+)$/);
    if (request.method === "POST" && alarmUpdateMatch) {
      const body = await readJson<AlarmInput>(request);
      const invalid = validateAlarmInput(body);
      if (invalid) return json(response, { error: invalid }, 400);
      return json(response, await service.updateAlarm(decodeURIComponent(alarmUpdateMatch[1]), body));
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

    const eqMatch = url.pathname.match(/^\/api\/zones\/([^/]+)\/eq$/);
    if (eqMatch) {
      const zoneId = decodeURIComponent(eqMatch[1]);
      if (request.method === "GET") return json(response, await service.zoneEq(zoneId));
      if (request.method === "POST") return json(response, await service.setZoneEq(zoneId, await readJson<EqPayload>(request)));
    }

    if (request.method === "GET" && url.pathname === "/api/devices") {
      return json(response, await service.listDevices());
    }

    if (request.method === "GET" && url.pathname === "/api/sources") {
      return json(response, await service.listSources());
    }

    // Custom per-source logos (uploaded from Settings). List/serve are public GETs;
    // upload (raw image bytes) and reset use POST to fit the existing CORS allowlist.
    if (request.method === "GET" && url.pathname === "/api/source-icons") {
      return json(response, await listSourceIcons(sourceIconsDir));
    }

    const sourceIconMatch = url.pathname.match(/^\/api\/source-icons\/([^/]+)$/);
    if (sourceIconMatch) {
      const sourceId = decodeURIComponent(sourceIconMatch[1]);
      if (request.method === "GET" || request.method === "HEAD") {
        return serveSourceIcon(sourceIconsDir, sourceId, response, request.method === "HEAD");
      }
      if (request.method === "POST") {
        const contentType = request.headers["content-type"] ?? "";
        const buf = await readBuffer(request);
        const result = await saveSourceIcon(sourceIconsDir, sourceId, contentType, buf);
        return result.ok ? json(response, result.meta, 201) : json(response, { error: result.error }, result.status);
      }
    }

    const sourceIconDeleteMatch = url.pathname.match(/^\/api\/source-icons\/([^/]+)\/delete$/);
    if (request.method === "POST" && sourceIconDeleteMatch) {
      const removed = await deleteSourceIcon(sourceIconsDir, decodeURIComponent(sourceIconDeleteMatch[1]));
      return removed ? empty(response, 204) : json(response, { error: "No custom icon" }, 404);
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

    const sourceAuthCookiesMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/auth\/cookies$/);
    if (request.method === "POST" && sourceAuthCookiesMatch) {
      const body = await readJson<{ paste?: string }>(request);
      if (!body.paste?.trim()) return json(response, { error: "Missing paste" }, 400);
      return json(response, await service.sourceAuthSetCookies(decodeURIComponent(sourceAuthCookiesMatch[1]), body.paste));
    }

    const sourceAuthCookiesClearMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/auth\/cookies\/clear$/);
    if (request.method === "POST" && sourceAuthCookiesClearMatch) {
      return json(response, await service.sourceAuthClearCookies(decodeURIComponent(sourceAuthCookiesClearMatch[1])));
    }

    const sourceSubsMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/subscriptions$/);
    if (request.method === "GET" && sourceSubsMatch) {
      return json(response, await service.sourceSubscriptions(decodeURIComponent(sourceSubsMatch[1])));
    }

    const sourcePinMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/pin$/);
    if (request.method === "POST" && sourcePinMatch) {
      const body = await readJson<{ id?: string; pinned?: boolean }>(request);
      if (!body.id) return json(response, { error: "Missing id" }, 400);
      return json(response, await service.sourcePin(decodeURIComponent(sourcePinMatch[1]), body.id, body.pinned !== false));
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
      const body = await readJson<{ trackIds: string[]; groupId: string; mode?: "replace" | "next" | "end"; autoplay?: boolean }>(request);
      if (!Array.isArray(body.trackIds) || body.trackIds.length === 0) return json(response, { error: "trackIds[] is required" }, 400);
      if (!body.groupId) return json(response, { error: "Missing groupId" }, 400);
      const mode = body.mode ?? "replace";
      const nowPlaying = await service.playSourceItems({ sourceId, trackIds: body.trackIds, groupId: body.groupId, mode, autoplay: body.autoplay });
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

    // --- Store: preferences, recently-viewed, EQ presets (POST-only writes; CORS untouched) ---

    const preferenceMatch = url.pathname.match(/^\/api\/preferences\/([^/]+)$/);
    if (preferenceMatch) {
      const key = decodeURIComponent(preferenceMatch[1]);
      if (request.method === "GET") {
        // Return 200 with a null value for an unset preference (an unset pref is normal
        // on first load) so the client falls back to its local cache without a 404.
        const pref = await store.getPreference(key);
        return json(response, pref ?? { key, value: null, updatedAt: "" });
      }
      if (request.method === "POST") {
        const body = await readJson<{ value: unknown }>(request);
        return json(response, await store.setPreference(key, body.value));
      }
    }

    if (url.pathname === "/api/recently-viewed") {
      if (request.method === "GET") {
        const sourceId = url.searchParams.get("sourceId") ?? undefined;
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
        return json(response, await store.listRecentlyViewed(sourceId, Number.isNaN(limit) ? undefined : limit));
      }
      if (request.method === "POST") {
        const body = await readJson<Omit<RecentlyViewedItem, "viewedAt">>(request);
        if (!body.sourceId || !body.itemId) return json(response, { error: "Missing sourceId or itemId" }, 400);
        await store.recordRecentlyViewed(body);
        return empty(response, 204);
      }
    }

    if (url.pathname === "/api/eq-presets") {
      if (request.method === "GET") return json(response, await store.listEqPresets());
      if (request.method === "POST") {
        const body = await readJson<Omit<EqPreset, "id" | "createdAt">>(request);
        if (!body.name) return json(response, { error: "Missing name" }, 400);
        return json(response, await store.createEqPreset(body), 201);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/eq-presets/delete") {
      const body = await readJson<{ id: number }>(request);
      if (typeof body.id !== "number") return json(response, { error: "Missing id" }, 400);
      await store.deleteEqPreset(body.id);
      return empty(response, 204);
    }

    // --- Store: library (favorites + playlists) (POST-only writes; CORS untouched) ---

    if (url.pathname === "/api/favorites") {
      if (request.method === "GET") return json(response, await store.listFavorites());
      if (request.method === "POST") {
        const body = await readJson<Omit<Favorite, "id" | "createdAt" | "preset">>(request);
        if (!body.sourceId || !body.itemId || !body.title) return json(response, { error: "Missing sourceId, itemId or title" }, 400);
        const kind = body.kind === "album" ? "album" : body.kind === "radio" ? "radio" : "track";
        return json(response, await store.addFavorite({ ...body, kind }), 201);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/favorites/delete") {
      const body = await readJson<{ sourceId: string; itemId: string }>(request);
      if (!body.sourceId || !body.itemId) return json(response, { error: "Missing sourceId or itemId" }, 400);
      await store.removeFavorite(body.sourceId, body.itemId);
      return empty(response, 204);
    }

    // Promote/demote a favorite as a one-tap preset. The favorite must already
    // exist (the web hook favorites first); this only flips the flag.
    if (request.method === "POST" && url.pathname === "/api/favorites/preset") {
      const body = await readJson<{ sourceId: string; itemId: string; preset: boolean }>(request);
      if (!body.sourceId || !body.itemId) return json(response, { error: "Missing sourceId or itemId" }, 400);
      const ok = await store.setFavoritePreset(body.sourceId, body.itemId, !!body.preset);
      if (!ok) return json(response, { error: "Only an existing radio favorite can be a preset" }, 400);
      return empty(response, 204);
    }

    if (url.pathname === "/api/playlists") {
      if (request.method === "GET") return json(response, await store.listPlaylists());
      if (request.method === "POST") {
        const body = await readJson<{ name: string }>(request);
        if (!body.name?.trim()) return json(response, { error: "Missing name" }, 400);
        return json(response, await store.createPlaylist(body.name.trim()), 201);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/playlists/delete") {
      const body = await readJson<{ id: number }>(request);
      if (typeof body.id !== "number") return json(response, { error: "Missing id" }, 400);
      await store.deletePlaylist(body.id);
      return empty(response, 204);
    }

    if (request.method === "POST" && url.pathname === "/api/playlists/from-queue") {
      const body = await readJson<{ name: string; groupId: string }>(request);
      if (!body.name?.trim() || !body.groupId) return json(response, { error: "Missing name or groupId" }, 400);
      const { items, skipped } = await service.queueTrackRefs(body.groupId);
      const playlist = await store.createPlaylist(body.name.trim());
      if (items.length > 0) await store.addPlaylistItems(playlist.id, items);
      return json(response, { playlist: { ...playlist, itemCount: items.length }, saved: items.length, skipped }, 201);
    }

    const playlistIdMatch = url.pathname.match(/^\/api\/playlists\/(\d+)$/);
    if (request.method === "GET" && playlistIdMatch) {
      const result = await store.getPlaylist(Number(playlistIdMatch[1]));
      return result ? json(response, result) : json(response, { error: "Playlist not found" }, 404);
    }

    const playlistRenameMatch = url.pathname.match(/^\/api\/playlists\/(\d+)\/rename$/);
    if (request.method === "POST" && playlistRenameMatch) {
      const body = await readJson<{ name: string }>(request);
      if (!body.name?.trim()) return json(response, { error: "Missing name" }, 400);
      return json(response, await store.renamePlaylist(Number(playlistRenameMatch[1]), body.name.trim()));
    }

    const playlistItemsMatch = url.pathname.match(/^\/api\/playlists\/(\d+)\/items$/);
    if (request.method === "POST" && playlistItemsMatch) {
      const id = Number(playlistItemsMatch[1]);
      const body = await readJson<{ sourceId: string; items: { id: string; kind: SourceItemKind; title: string; artist?: string; album?: string; durationSeconds?: number }[] }>(request);
      if (!body.sourceId || !Array.isArray(body.items)) return json(response, { error: "sourceId and items[] required" }, 400);
      const rows: { sourceId: string; trackId: string; title: string; artist: string | null; album: string | null; durationSeconds: number | null }[] = [];
      let skipped = 0;
      for (const item of body.items) {
        if (item.kind === "album" || item.kind === "container") {
          // Flatten albums/containers into their playable tracks at add-time.
          try {
            const expansion = await service.browseSource(body.sourceId, item.id);
            for (const child of expansion.items) {
              if (child.kind === "playable") {
                rows.push({ sourceId: body.sourceId, trackId: child.id, title: child.title, artist: child.artist ?? null, album: child.album ?? null, durationSeconds: child.durationSeconds ?? null });
              }
            }
          } catch {
            skipped++;
          }
        } else {
          rows.push({ sourceId: body.sourceId, trackId: item.id, title: item.title, artist: item.artist ?? null, album: item.album ?? null, durationSeconds: item.durationSeconds ?? null });
        }
      }
      const added = await store.addPlaylistItems(id, rows);
      return json(response, { added, skipped }, 201);
    }

    const playlistItemRemoveMatch = url.pathname.match(/^\/api\/playlists\/(\d+)\/items\/remove$/);
    if (request.method === "POST" && playlistItemRemoveMatch) {
      const body = await readJson<{ itemId: number }>(request);
      if (typeof body.itemId !== "number") return json(response, { error: "Missing itemId" }, 400);
      await store.removePlaylistItem(body.itemId);
      return empty(response, 204);
    }

    const playlistReorderMatch = url.pathname.match(/^\/api\/playlists\/(\d+)\/reorder$/);
    if (request.method === "POST" && playlistReorderMatch) {
      const body = await readJson<{ orderedItemIds: number[] }>(request);
      if (!Array.isArray(body.orderedItemIds)) return json(response, { error: "orderedItemIds[] required" }, 400);
      return json(response, await store.reorderPlaylist(Number(playlistReorderMatch[1]), body.orderedItemIds));
    }

    const playlistPlayMatch = url.pathname.match(/^\/api\/playlists\/(\d+)\/play$/);
    if (request.method === "POST" && playlistPlayMatch) {
      const body = await readJson<{ groupId: string; mode?: PlaybackMode }>(request);
      if (!body.groupId) return json(response, { error: "Missing groupId" }, 400);
      const result = await store.getPlaylist(Number(playlistPlayMatch[1]));
      if (!result || result.items.length === 0) return json(response, { error: "Playlist is empty" }, 400);
      const refs = result.items.map((item) => ({ sourceId: item.sourceId, trackId: item.trackId }));
      return json(response, await service.playTrackRefs(refs, body.groupId, body.mode ?? "replace"));
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
  return (await readBuffer(request)).toString("utf8");
}

async function readBuffer(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown bridge error";
}

function isTransportAction(value: unknown): value is TransportAction {
  return value === "play" || value === "pause" || value === "stop" || value === "next" || value === "previous";
}

function validateAlarmInput(body: AlarmInput): string | null {
  if (!body || typeof body !== "object") return "Missing body";
  if (!body.roomUuid) return "Missing roomUuid";
  if (typeof body.startTime !== "string" || !/^\d{2}:\d{2}(:\d{2})?$/.test(body.startTime)) return "Invalid startTime (HH:MM)";
  if (typeof body.volume !== "number" || body.volume < 0 || body.volume > 100) return "Invalid volume (0-100)";
  if (body.program !== "chime" && body.program !== "queue" && body.program !== "other") return "Invalid program";
  const recurrence = body.recurrence;
  const isPreset = recurrence === "once" || recurrence === "daily" || recurrence === "weekdays" || recurrence === "weekends";
  const isDays = typeof recurrence === "object" && recurrence !== null && Array.isArray((recurrence as { days?: unknown }).days)
    && (recurrence as { days: unknown[] }).days.every((day) => typeof day === "number" && day >= 0 && day <= 6);
  if (!isPreset && !isDays) return "Invalid recurrence";
  return null;
}
