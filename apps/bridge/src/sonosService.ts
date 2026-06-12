import { firstDidlItem, parseDidlItems, type BridgeSnapshot, type NowPlaying, type PlaybackState, type QueueItem, type SonosGroup, type SonosZone, type TransportAction, type VolumePayload, type VolumeState } from "@misonos/sonos-protocol";
import { loadConfig, type BridgeConfig } from "./config.js";
import { discoverSsdp } from "./ssdp.js";
import { callSoap, SonosSoapError, type ServiceType } from "./sonosSoap.js";
import { fetchDeviceInfo } from "./deviceInfo.js";
import type { PlaybackMode, SonosDeviceInfo, SourceBrowseResponse, SourceDescriptor, SourceTrackInfo } from "@misonos/sonos-protocol";
import { browseSource, fetchTrack, listSources, searchSource, sourceAuthStart, sourceAuthSignOut, sourceAuthStatus } from "./sources.js";
import {
  buildServiceUri,
  detectLanIp,
  getPreset,
  listPresets,
  registerCustomService,
  type CustomServicePresetView,
  type RegisterCustomServiceResult
} from "./customServices.js";
import { discoverMusicServices, fetchSonosAccounts, type MusicServiceDiscovery, type SonosAccountsResponse } from "./musicServices.js";
import { parseZoneGroupState, zoneFromDeviceDescription } from "./topology.js";

export interface SmapiAccountScanOptions {
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
}

export interface SmapiSoapAttempt {
  ok: boolean;
  status?: number;
  faultCode?: string;
  message?: string;
}

export interface SmapiAccountScanAttempt {
  sn: number;
  uri: string;
  addUriToQueue: SmapiSoapAttempt;
  play?: SmapiSoapAttempt;
  outcome: "queue-rejected" | "queue-fault" | "queue-accepted" | "play-fault" | "play-accepted";
}

export interface SmapiAccountScanResult {
  sourceId: string;
  groupId: string;
  coordinatorId: string;
  coordinatorIp: string;
  sid: number;
  serviceTokenMagic: number;
  flags: number;
  uriScheme: string;
  descMode: "anonymous" | "token";
  trackId: string;
  startSn: number;
  endSn: number;
  playOnSuccess: boolean;
  clearQueueBeforeEach: boolean;
  serviceRefresh?: SmapiSoapAttempt;
  results: SmapiAccountScanAttempt[];
  summary: Record<string, number>;
  scannedAt: string;
}

export class SonosService {
  private zones = new Map<string, SonosZone>();
  private groups = new Map<string, SonosGroup>();
  private lastDiscovery = 0;
  private rediscoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private rediscoveryInProgress = false;
  onSnapshot?: (snapshot: BridgeSnapshot) => void;

  constructor(private readonly config: BridgeConfig = loadConfig()) {}

  private publicHost(): string | null {
    return process.env.MISONOS_BRIDGE_PUBLIC_HOST ?? detectLanIp();
  }

  private scheduleRediscovery(reason: string): void {
    if (this.rediscoveryTimer || this.rediscoveryInProgress) return;
    console.warn(`[bridge] scheduling rediscovery (${reason})`);
    this.rediscoveryTimer = setTimeout(async () => {
      this.rediscoveryTimer = undefined;
      this.rediscoveryInProgress = true;
      try {
        const snapshot = await this.discover();
        this.onSnapshot?.(snapshot);
      } catch (error) {
        console.warn(`[bridge] rediscovery failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.rediscoveryInProgress = false;
      }
    }, 1500);
  }

  private async guardSoap<T>(zoneIdForLogging: string | undefined, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (looksLikeConnectionFailure(error)) {
        this.scheduleRediscovery(zoneIdForLogging ? `zone ${zoneIdForLogging} unreachable` : "soap call failed");
      }
      throw error;
    }
  }

  async snapshot(forceDiscovery = false): Promise<BridgeSnapshot> {
    if (forceDiscovery || this.zones.size === 0 || Date.now() - this.lastDiscovery > 30_000) {
      await this.discover();
    }
    return {
      zones: [...this.zones.values()].filter((zone) => zone.visible),
      groups: [...this.groups.values()]
    };
  }

  async discover(): Promise<BridgeSnapshot> {
    const discovered = await discoverSsdp(this.config.discoveryTimeoutMs);
    const manual = this.config.manualSpeakerIps.map((ipAddress) => ({
      ipAddress,
      location: `http://${ipAddress}:1400/xml/device_description.xml`
    }));

    const devices = [...manual, ...discovered];
    const zones = await Promise.all(
      devices.map(async (device) => {
        try {
          const response = await fetch(device.location, { signal: AbortSignal.timeout(3500) });
          return zoneFromDeviceDescription(device.ipAddress, device.location, await response.text());
        } catch {
          return {
            id: device.ipAddress,
            uuid: device.ipAddress,
            name: device.ipAddress,
            ipAddress: device.ipAddress,
            location: device.location,
            visible: true
          } satisfies SonosZone;
        }
      })
    );

    this.zones = new Map(zones.map((zone) => [zone.uuid, zone]));
    await this.refreshTopology(zones[0]);
    this.lastDiscovery = Date.now();
    return this.snapshot(false);
  }

  async nowPlaying(groupId: string): Promise<NowPlaying> {
    const group = await this.requireGroup(groupId);
    const coordinator = await this.requireZone(group.coordinatorId);
    return this.guardSoap(coordinator.uuid, async () => {
      const [position, transport] = await Promise.all([
        callSoap(coordinator.ipAddress, "AVTransport", "GetPositionInfo", { InstanceID: 0 }),
        callSoap(coordinator.ipAddress, "AVTransport", "GetTransportInfo", { InstanceID: 0 })
      ]);
      const baseUrl = `http://${coordinator.ipAddress}:1400`;
      const item = firstDidlItem(position.TrackMetaData, baseUrl);
      return {
        groupId,
        state: normalizePlaybackState(transport.CurrentTransportState),
        title: item?.title ?? position.TrackURI ?? "Nothing playing",
        artist: item?.artist,
        album: item?.album,
        albumArtUri: item?.albumArtUri ?? albumArtFromPosition(position, baseUrl),
        duration: position.TrackDuration,
        position: position.RelTime,
        playlistPosition: numericPosition(position.Track),
        uri: position.TrackURI,
        updatedAt: new Date().toISOString()
      };
    });
  }

  async queue(groupId: string): Promise<QueueItem[]> {
    const group = await this.requireGroup(groupId);
    const coordinator = await this.requireZone(group.coordinatorId);
    return this.guardSoap(coordinator.uuid, async () => {
      const response = await callSoap(coordinator.ipAddress, "ContentDirectory", "Browse", {
        ObjectID: "Q:0",
        BrowseFlag: "BrowseDirectChildren",
        Filter: "*",
        StartingIndex: 0,
        RequestedCount: 100,
        SortCriteria: ""
      });
      return parseDidlItems(response.Result, `http://${coordinator.ipAddress}:1400`);
    });
  }

  async transport(groupId: string, action: TransportAction): Promise<NowPlaying> {
    const group = await this.requireGroup(groupId);
    const coordinator = await this.requireZone(group.coordinatorId);
    const soapAction = {
      play: "Play",
      pause: "Pause",
      stop: "Stop",
      next: "Next",
      previous: "Previous"
    } satisfies Record<TransportAction, string>;
    const args = action === "play" ? { InstanceID: 0, Speed: 1 } : { InstanceID: 0 };
    await callSoap(coordinator.ipAddress, "AVTransport", soapAction[action], args);
    return this.nowPlayingSettled(groupId);
  }

  async seekToPosition(groupId: string, positionSeconds: number): Promise<NowPlaying> {
    const group = await this.requireGroup(groupId);
    const coordinator = await this.requireZone(group.coordinatorId);
    const hh = Math.floor(positionSeconds / 3600);
    const mm = Math.floor((positionSeconds % 3600) / 60);
    const ss = Math.floor(positionSeconds % 60);
    const target = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    await callSoap(coordinator.ipAddress, "AVTransport", "Seek", {
      InstanceID: 0,
      Unit: "REL_TIME",
      Target: target
    });
    return this.nowPlayingSettled(groupId);
  }

  async playQueueIndex(groupId: string, index: number): Promise<NowPlaying> {
    const group = await this.requireGroup(groupId);
    const coordinator = await this.requireZone(group.coordinatorId);
    await callSoap(coordinator.ipAddress, "AVTransport", "Seek", {
      InstanceID: 0,
      Unit: "TRACK_NR",
      Target: index
    });
    await callSoap(coordinator.ipAddress, "AVTransport", "Play", { InstanceID: 0, Speed: 1 });
    return this.nowPlayingSettled(groupId);
  }

  async zoneVolume(zoneId: string): Promise<VolumeState> {
    const zone = await this.requireZone(zoneId);
    return this.guardSoap(zone.uuid, async () => {
      const [volume, mute] = await Promise.all([
        callSoap(zone.ipAddress, "RenderingControl", "GetVolume", {
          InstanceID: 0,
          Channel: "Master"
        }),
        callSoap(zone.ipAddress, "RenderingControl", "GetMute", {
          InstanceID: 0,
          Channel: "Master"
        })
      ]);
      return {
        id: zone.id,
        volume: clampVolume(Number.parseInt(volume.CurrentVolume ?? "0", 10)),
        muted: mute.CurrentMute === "1"
      };
    });
  }

  async setVolume(zoneId: string, payload: VolumePayload): Promise<VolumeState> {
    const zone = await this.requireZone(zoneId);
    let nextVolume = payload.volume;
    if (nextVolume === undefined) {
      nextVolume = (await this.zoneVolume(zoneId)).volume + (payload.delta ?? 0);
    }
    const volume = clampVolume(nextVolume);
    await callSoap(zone.ipAddress, "RenderingControl", "SetVolume", {
      InstanceID: 0,
      Channel: "Master",
      DesiredVolume: volume
    });
    if (payload.muted !== undefined) {
      await this.setZoneMute(zoneId, payload.muted);
    }
    return this.zoneVolume(zoneId);
  }

  async setZoneMute(zoneId: string, muted: boolean): Promise<VolumeState> {
    const zone = await this.requireZone(zoneId);
    await callSoap(zone.ipAddress, "RenderingControl", "SetMute", {
      InstanceID: 0,
      Channel: "Master",
      DesiredMute: muted ? 1 : 0
    });
    return this.zoneVolume(zoneId);
  }

  async groupVolume(groupId: string): Promise<VolumeState> {
    const group = await this.requireGroup(groupId);
    const coordinator = await this.requireZone(group.coordinatorId);
    return this.guardSoap(coordinator.uuid, async () => {
      const [volume, mute] = await Promise.all([
        callSoap(coordinator.ipAddress, "GroupRenderingControl", "GetGroupVolume", { InstanceID: 0 }),
        callSoap(coordinator.ipAddress, "GroupRenderingControl", "GetGroupMute", { InstanceID: 0 })
      ]);
      return {
        id: group.id,
        volume: clampVolume(Number.parseInt(volume.CurrentVolume ?? "0", 10)),
        muted: mute.CurrentMute === "1"
      };
    });
  }

  async setGroupVolume(groupId: string, payload: VolumePayload): Promise<VolumeState> {
    const group = await this.requireGroup(groupId);
    const coordinator = await this.requireZone(group.coordinatorId);
    let nextVolume = payload.volume;
    if (nextVolume === undefined) {
      nextVolume = (await this.groupVolume(groupId)).volume + (payload.delta ?? 0);
    }
    await callSoap(coordinator.ipAddress, "GroupRenderingControl", "SetGroupVolume", {
      InstanceID: 0,
      DesiredVolume: clampVolume(nextVolume)
    });
    if (payload.muted !== undefined) {
      await this.setGroupMute(groupId, payload.muted);
    }
    return this.groupVolume(groupId);
  }

  async setGroupMute(groupId: string, muted: boolean): Promise<VolumeState> {
    const group = await this.requireGroup(groupId);
    const coordinator = await this.requireZone(group.coordinatorId);
    await callSoap(coordinator.ipAddress, "GroupRenderingControl", "SetGroupMute", {
      InstanceID: 0,
      DesiredMute: muted ? 1 : 0
    });
    return this.groupVolume(groupId);
  }

  async joinZoneToGroup(zoneId: string, groupId: string): Promise<BridgeSnapshot> {
    const zone = await this.requireZone(zoneId);
    const group = await this.requireGroup(groupId);
    if (zone.groupId === group.id && zone.coordinatorId === group.coordinatorId) {
      return this.snapshot();
    }
    const coordinator = await this.requireZone(group.coordinatorId);
    await callSoap(zone.ipAddress, "AVTransport", "SetAVTransportURI", {
      InstanceID: 0,
      CurrentURI: `x-rincon:${coordinator.uuid}`,
      CurrentURIMetaData: ""
    });
    await sleep(1200);
    return this.discover();
  }

  async promoteZoneToCoordinator(zoneId: string): Promise<BridgeSnapshot> {
    const zone = await this.requireZone(zoneId);
    if (!zone.groupId) throw new Error("Zone is not in a group");
    const group = await this.requireGroup(zone.groupId);
    if (group.coordinatorId === zone.uuid) return this.snapshot();
    const coordinator = await this.requireZone(group.coordinatorId);
    await callSoap(coordinator.ipAddress, "AVTransport", "DelegateGroupCoordinationTo", {
      InstanceID: 0,
      NewCoordinator: zone.uuid,
      RejoinGroup: 1
    });
    await sleep(1200);
    return this.discover();
  }

  async makeZoneStandalone(zoneId: string): Promise<BridgeSnapshot> {
    const zone = await this.requireZone(zoneId);
    await callSoap(zone.ipAddress, "AVTransport", "BecomeCoordinatorOfStandaloneGroup", {
      InstanceID: 0
    });
    await sleep(1200);
    return this.discover();
  }

  async listMusicServices(): Promise<MusicServiceDiscovery> {
    const seed = [...this.zones.values()].find((zone) => zone.visible);
    if (!seed) throw new Error("No reachable Sonos zone");
    return discoverMusicServices(seed);
  }

  async listSonosAccounts(): Promise<SonosAccountsResponse> {
    const seed = [...this.zones.values()].find((zone) => zone.visible);
    if (!seed) throw new Error("No reachable Sonos zone");
    return fetchSonosAccounts(seed);
  }

  async deviceInfo(zoneId: string): Promise<SonosDeviceInfo> {
    const zone = await this.requireZone(zoneId);
    return fetchDeviceInfo(zone);
  }

  listSources(): Promise<SourceDescriptor[]> {
    return listSources();
  }

  browseSource(sourceId: string, id?: string): Promise<SourceBrowseResponse> {
    return browseSource(sourceId, id);
  }

  searchSource(sourceId: string, query: string, type?: string): Promise<SourceBrowseResponse> {
    return searchSource(sourceId, query, type);
  }

  sourceAuthStatus(sourceId: string): Promise<unknown> {
    return sourceAuthStatus(sourceId);
  }

  sourceAuthStart(sourceId: string): Promise<unknown> {
    return sourceAuthStart(sourceId);
  }

  sourceAuthSignOut(sourceId: string): Promise<unknown> {
    return sourceAuthSignOut(sourceId);
  }

  fetchSourceTrack(sourceId: string, id: string): Promise<SourceTrackInfo> {
    return fetchTrack(sourceId, id);
  }

  async scanSmapiAccountIndices(options: SmapiAccountScanOptions): Promise<SmapiAccountScanResult> {
    const sourceId = options.sourceId ?? "youtube-music";
    const baseSmapi = SMAPI_SOURCE_INFO[sourceId];
    if (!baseSmapi && options.sid === undefined) throw new Error(`No SMAPI source info for ${sourceId}`);

    const sid = options.sid ?? baseSmapi?.sid;
    const serviceTokenMagic = options.serviceTokenMagic ?? baseSmapi?.serviceTokenMagic;
    if (sid === undefined || serviceTokenMagic === undefined) {
      throw new Error("sid and serviceTokenMagic are required for unknown SMAPI sources");
    }
    const startSn = options.startSn ?? 0;
    const endSn = options.endSn ?? 255;
    if (!Number.isInteger(startSn) || !Number.isInteger(endSn) || startSn < 0 || endSn > 255 || startSn > endSn) {
      throw new Error("startSn/endSn must be an inclusive range inside 0..255");
    }
    if (endSn - startSn > 255) throw new Error("SMAPI sn scan range is too large");

    const group = options.groupId
      ? await this.requireGroup(options.groupId)
      : await this.firstGroup();
    const coordinator = await this.requireZone(group.coordinatorId);
    const track = await this.scanTrack(sourceId, options.trackId);
    const ext = options.ext ?? extensionForMime(track.mimeType);
    const flags = options.flags ?? 8224;
    const uriScheme = options.uriScheme ?? "x-sonos-http";
    const descMode = options.descMode ?? baseSmapi?.descMode ?? "anonymous";
    const refreshServices = options.refreshServices ?? true;
    const playOnSuccess = options.playOnSuccess ?? false;
    const clearQueueBeforeEach = options.clearQueueBeforeEach ?? playOnSuccess;
    const stopAfterPlay = options.stopAfterPlay ?? true;

    const serviceRefresh = refreshServices
      ? await this.trySoap(coordinator.ipAddress, "MusicServices", "UpdateAvailableServices")
      : undefined;
    const results: SmapiAccountScanAttempt[] = [];

    for (let sn = startSn; sn <= endSn; sn += 1) {
      if (clearQueueBeforeEach) {
        await this.trySoap(coordinator.ipAddress, "AVTransport", "RemoveAllTracksFromQueue", { InstanceID: 0 });
      }

      const smapi = { sid, sn, serviceTokenMagic };
      const uri = buildSmapiUri(track.id, ext, smapi, flags, uriScheme);
      const metadata = buildSmapiDidl({ ...track, id: track.id, url: uri }, smapi, descMode);
      const attempt: SmapiAccountScanAttempt = { sn, uri, addUriToQueue: { ok: false }, outcome: "queue-rejected" };
      results.push(attempt);

      const enqueue = await this.trySoap(coordinator.ipAddress, "AVTransport", "AddURIToQueue", {
        InstanceID: 0,
        EnqueuedURI: uri,
        EnqueuedURIMetaData: metadata,
        DesiredFirstTrackNumberEnqueued: 0,
        EnqueueAsNext: 0
      });
      attempt.addUriToQueue = enqueue;
      if (!enqueue.ok) {
        attempt.outcome = enqueue.faultCode === "800" ? "queue-rejected" : "queue-fault";
        continue;
      }

      attempt.outcome = "queue-accepted";
      if (!playOnSuccess) continue;

      await this.trySoap(coordinator.ipAddress, "AVTransport", "SetAVTransportURI", {
        InstanceID: 0,
        CurrentURI: `x-rincon-queue:${coordinator.uuid}#0`,
        CurrentURIMetaData: ""
      });
      await this.trySoap(coordinator.ipAddress, "AVTransport", "Seek", { InstanceID: 0, Unit: "TRACK_NR", Target: "1" });
      const play = await this.trySoap(coordinator.ipAddress, "AVTransport", "Play", { InstanceID: 0, Speed: 1 });
      attempt.play = play;
      attempt.outcome = play.ok ? "play-accepted" : "play-fault";

      if (stopAfterPlay) {
        await this.trySoap(coordinator.ipAddress, "AVTransport", "Stop", { InstanceID: 0 });
      }
    }

    return {
      sourceId,
      groupId: group.id,
      coordinatorId: coordinator.uuid,
      coordinatorIp: coordinator.ipAddress,
      sid,
      serviceTokenMagic,
      flags,
      uriScheme,
      descMode,
      trackId: track.id,
      startSn,
      endSn,
      playOnSuccess,
      clearQueueBeforeEach,
      serviceRefresh,
      results,
      summary: summarizeSmapiScan(results),
      scannedAt: new Date().toISOString()
    };
  }

  async playSourceItems(options: { sourceId: string; trackIds: string[]; groupId: string; mode: PlaybackMode }): Promise<NowPlaying> {
    if (options.trackIds.length === 0) throw new Error("trackIds must be non-empty");
    const group = await this.requireGroup(options.groupId);
    const coordinator = await this.requireZone(group.coordinatorId);
    const tracks = await Promise.all(options.trackIds.map((trackId) => fetchTrack(options.sourceId, trackId)));
    const bridgeHost = this.publicHost();
    if (!bridgeHost) throw new Error("Could not determine bridge LAN IP for stream proxy");
    const queueItems = tracks.map((track, index) => {
      const ext = extensionForMime(track.mimeType);
      const titleSlug = urlSafeSlug(track.title);
      const proxyUrl = `http://${bridgeHost}:${this.config.port}/api/stream/${encodeURIComponent(options.sourceId)}/${encodeURIComponent(options.trackIds[index])}/${titleSlug}${ext}`;
      // For sources registered as a Sonos SMAPI custom service (sid=255 by
      // default), use the x-sonosapi-stream:// URI scheme so Sonos calls our
      // SMAPI endpoint for the actual URL + metadata. Required for non-mp3
      // streams (audio/mp4) where S1 ignores DIDL on plain http URIs.
      const smapi = SMAPI_SOURCE_INFO[options.sourceId];
      if (smapi) {
        // x-sonos-http on-demand URI. sid here is the raw sid (255 for custom),
        // and serviceTokenMagic is what goes into the desc <SA_RINCON...>
        // binding, not the URI sid. S1's sid=255 custom slot uses 65280.
        const smapiUri = `x-sonos-http:${encodeURIComponent(options.trackIds[index])}${ext}?sid=${smapi.sid}&flags=8224&sn=${smapi.sn}`;
        const metadata = buildSmapiDidl({
          ...track,
          id: options.trackIds[index],
          url: smapiUri
        }, smapi);
        return { uri: smapiUri, metadata };
      }
      const proxiedTrack: SourceTrackInfo = { ...track, url: proxyUrl };
      return { uri: proxyUrl, metadata: buildDidl(proxiedTrack) };
    });

    if (options.mode === "replace") {
      await callSoap(coordinator.ipAddress, "AVTransport", "RemoveAllTracksFromQueue", { InstanceID: 0 });
      for (const item of queueItems) {
        await callSoap(coordinator.ipAddress, "AVTransport", "AddURIToQueue", {
          InstanceID: 0,
          EnqueuedURI: item.uri,
          EnqueuedURIMetaData: item.metadata,
          DesiredFirstTrackNumberEnqueued: 0,
          EnqueueAsNext: 0
        });
      }
      await callSoap(coordinator.ipAddress, "AVTransport", "SetAVTransportURI", {
        InstanceID: 0,
        CurrentURI: `x-rincon-queue:${coordinator.uuid}#0`,
        CurrentURIMetaData: ""
      });
      await callSoap(coordinator.ipAddress, "AVTransport", "Seek", { InstanceID: 0, Unit: "TRACK_NR", Target: "1" });
      await callSoap(coordinator.ipAddress, "AVTransport", "Play", { InstanceID: 0, Speed: 1 });
    } else if (options.mode === "next") {
      // EnqueueAsNext=1 alone isn't reliable on Sonos S1 — it can append. Read
      // the current track number and insert explicitly at currentTrack+1.
      const position = await callSoap(coordinator.ipAddress, "AVTransport", "GetPositionInfo", { InstanceID: 0 });
      const currentTrack = Number.parseInt(position.Track ?? "0", 10);
      const insertAt = Number.isFinite(currentTrack) && currentTrack > 0 ? currentTrack + 1 : 1;
      // Walk in order; each successive insert goes right after the previous one
      // so the selected set lands contiguous after the currently playing track.
      for (let index = 0; index < queueItems.length; index++) {
        const item = queueItems[index];
        await callSoap(coordinator.ipAddress, "AVTransport", "AddURIToQueue", {
          InstanceID: 0,
          EnqueuedURI: item.uri,
          EnqueuedURIMetaData: item.metadata,
          DesiredFirstTrackNumberEnqueued: insertAt + index,
          EnqueueAsNext: 1
        });
      }
    } else {
      for (const item of queueItems) {
        await callSoap(coordinator.ipAddress, "AVTransport", "AddURIToQueue", {
          InstanceID: 0,
          EnqueuedURI: item.uri,
          EnqueuedURIMetaData: item.metadata,
          DesiredFirstTrackNumberEnqueued: 0,
          EnqueueAsNext: 0
        });
      }
    }

    return this.nowPlaying(options.groupId);
  }

  listCustomServicePresets(): CustomServicePresetView[] {
    return listPresets();
  }

  async registerCustomServiceOnZone(options: {
    presetId: string;
    zoneId: string;
    hostOverride?: string;
    uriOverride?: string;
    secureUri?: string;
  }): Promise<RegisterCustomServiceResult> {
    const preset = getPreset(options.presetId);
    if (!preset) throw new Error(`Unknown preset: ${options.presetId}`);
    const zone = await this.requireZone(options.zoneId);
    const host = options.hostOverride ?? detectLanIp();
    if (!options.uriOverride && !host) throw new Error("Could not detect LAN IP; provide uri override");
    const uri = options.uriOverride ?? buildServiceUri(preset, host as string);
    return registerCustomService({ speakerIp: zone.ipAddress, preset, uri, secureUri: options.secureUri });
  }

  async listDevices(): Promise<SonosDeviceInfo[]> {
    const visible = [...this.zones.values()].filter((zone) => zone.visible);
    const results = await Promise.all(visible.map((zone) => fetchDeviceInfo(zone)));
    return results.sort((a, b) => a.zoneName.localeCompare(b.zoneName));
  }

  async browseContainer(options: {
    objectId: string;
    startingIndex?: number;
    requestedCount?: number;
    filter?: string;
    sortCriteria?: string;
  }): Promise<{ raw: string; items: QueueItem[]; numberReturned?: string; totalMatches?: string }> {
    const seed = [...this.zones.values()].find((zone) => zone.visible);
    if (!seed) throw new Error("No reachable Sonos zone");
    const response = await callSoap(seed.ipAddress, "ContentDirectory", "Browse", {
      ObjectID: options.objectId,
      BrowseFlag: "BrowseDirectChildren",
      Filter: options.filter ?? "*",
      StartingIndex: options.startingIndex ?? 0,
      RequestedCount: options.requestedCount ?? 25,
      SortCriteria: options.sortCriteria ?? ""
    });
    return {
      raw: response.Result ?? "",
      items: parseDidlItems(response.Result, `http://${seed.ipAddress}:1400`),
      numberReturned: response.NumberReturned,
      totalMatches: response.TotalMatches
    };
  }

  async searchContainer(options: {
    containerId: string;
    searchCriteria: string;
    startingIndex?: number;
    requestedCount?: number;
    filter?: string;
    sortCriteria?: string;
  }): Promise<{ raw: string; items: QueueItem[]; numberReturned?: string; totalMatches?: string }> {
    const seed = [...this.zones.values()].find((zone) => zone.visible);
    if (!seed) throw new Error("No reachable Sonos zone");
    const response = await callSoap(seed.ipAddress, "ContentDirectory", "Search", {
      ContainerID: options.containerId,
      SearchCriteria: options.searchCriteria,
      Filter: options.filter ?? "*",
      StartingIndex: options.startingIndex ?? 0,
      RequestedCount: options.requestedCount ?? 25,
      SortCriteria: options.sortCriteria ?? ""
    });
    return {
      raw: response.Result ?? "",
      items: parseDidlItems(response.Result, `http://${seed.ipAddress}:1400`),
      numberReturned: response.NumberReturned,
      totalMatches: response.TotalMatches
    };
  }

  private async firstGroup(): Promise<SonosGroup> {
    await this.snapshot();
    const group = [...this.groups.values()][0];
    if (!group) throw new Error("No reachable Sonos group");
    return group;
  }

  private async scanTrack(sourceId: string, trackId: string | undefined): Promise<SourceTrackInfo> {
    if (trackId) return fetchTrack(sourceId, trackId);
    return {
      id: "misonos-smapi-sn-scan",
      title: "MiSonos SMAPI SN Scan",
      artist: "MiSonos",
      album: "Diagnostics",
      url: "",
      mimeType: "audio/mp4"
    };
  }

  private async trySoap(
    ipAddress: string,
    serviceType: ServiceType,
    action: string,
    args: Record<string, unknown> = {}
  ): Promise<SmapiSoapAttempt> {
    try {
      await callSoap(ipAddress, serviceType, action, args);
      return { ok: true };
    } catch (error) {
      if (error instanceof SonosSoapError) {
        return { ok: false, status: error.status, faultCode: error.faultCode, message: error.message };
      }
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async refreshTopology(seed?: SonosZone): Promise<void> {
    if (!seed) {
      this.groups = new Map();
      return;
    }
    try {
      const response = await callSoap(seed.ipAddress, "ZoneGroupTopology", "GetZoneGroupState");
      const topology = parseZoneGroupState(response.ZoneGroupState);
      this.zones = new Map(topology.zones.map((zone) => [zone.uuid, zone]));
      this.groups = new Map(topology.groups.map((group) => [group.id, group]));
    } catch {
      const fallbackGroups = [...this.zones.values()].map((zone) => ({
        id: zone.uuid,
        coordinatorId: zone.uuid,
        coordinatorName: zone.name,
        zones: [zone]
      }));
      this.groups = new Map(fallbackGroups.map((group) => [group.id, group]));
    }
  }

  async nowPlayingSettled(groupId: string): Promise<NowPlaying> {
    let latest = await this.nowPlaying(groupId);
    for (let attempt = 0; attempt < 4 && latest.state === "TRANSITIONING"; attempt += 1) {
      await sleep(650);
      latest = await this.nowPlaying(groupId);
    }
    return latest;
  }

  private async requireGroup(groupId: string): Promise<SonosGroup> {
    await this.snapshot();
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Unknown Sonos group: ${groupId}`);
    return group;
  }

  private async requireZone(zoneId: string): Promise<SonosZone> {
    await this.snapshot();
    const zone = this.zones.get(zoneId) ?? [...this.zones.values()].find((candidate) => candidate.ipAddress === zoneId);
    if (!zone) throw new Error(`Unknown Sonos zone: ${zoneId}`);
    return zone;
  }
}

function normalizePlaybackState(value: string | undefined): PlaybackState {
  if (value === "PLAYING" || value === "PAUSED_PLAYBACK" || value === "STOPPED" || value === "TRANSITIONING" || value === "NO_MEDIA_PRESENT") {
    return value;
  }
  return "UNKNOWN";
}

function numericPosition(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function albumArtFromPosition(position: Record<string, string>, baseUrl: string): string | undefined {
  const uri = position.AlbumArtURI;
  if (!uri) return undefined;
  if (/^https?:\/\//i.test(uri)) return uri;
  return `${baseUrl}${uri.startsWith("/") ? "" : "/"}${uri}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENOTFOUND"
]);

function looksLikeConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  const message = error.message.toLowerCase();
  if (message.includes("aborted") || message.includes("timeout") || message.includes("network")) return true;
  for (const code of CONNECTION_ERROR_CODES) if (message.includes(code.toLowerCase())) return true;
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && cause !== null) {
    const code = (cause as { code?: string }).code;
    if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) return true;
    const causeMessage = (cause as { message?: string }).message;
    if (typeof causeMessage === "string") {
      const lower = causeMessage.toLowerCase();
      if (lower.includes("timeout") || lower.includes("aborted")) return true;
    }
  }
  return false;
}

function buildDidl(track: SourceTrackInfo): string {
  const mime = track.mimeType ?? "audio/mpeg";
  // Sonos drops user-supplied metadata (falling back to URL basename) when the
  // protocolInfo doesn't carry DLNA streaming flags for non-MP3 mimes. Force
  // streaming + byte-seek hints regardless of mime so the title we pass sticks.
  const protocolInfo = `http-get:*:${escapeXml(mime)}:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000`;
  const durationAttr = typeof track.durationSeconds === "number" && track.durationSeconds > 0
    ? ` duration="${formatUpnpDuration(track.durationSeconds)}"`
    : "";
  // Element order matters for some DIDL parsers — keep title/creator first,
  // then res, then upnp:class. albumArtURI goes after class per spec.
  const inner =
    `<item id="${escapeXml(track.id)}" parentID="-1" restricted="true">` +
    `<dc:title>${escapeXml(track.title)}</dc:title>` +
    (track.artist ? `<dc:creator>${escapeXml(track.artist)}</dc:creator>` : "") +
    (track.artist ? `<upnp:artist>${escapeXml(track.artist)}</upnp:artist>` : "") +
    (track.album ? `<upnp:album>${escapeXml(track.album)}</upnp:album>` : "") +
    `<res protocolInfo="${protocolInfo}"${durationAttr}>${escapeXml(track.url)}</res>` +
    `<upnp:class>object.item.audioItem.musicTrack</upnp:class>` +
    (track.albumArtUri ? `<upnp:albumArtURI>${escapeXml(track.albumArtUri)}</upnp:albumArtURI>` : "") +
    `</item>`;
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${inner}</DIDL-Lite>`;
}

interface SmapiSourceInfo {
  sid: number;
  sn: number;
  // The "cdudn" desc id Sonos uses to map a stream back to its music service.
  serviceTokenMagic: number;
  descMode?: "anonymous" | "token";
}

const SMAPI_SOURCE_INFO: Record<string, SmapiSourceInfo> = {
  // S1 customsd accepts raw sid=255, but x-sonos-http queue parsing only
  // accepts the legacy custom-service token id Svc65280 for that slot.
  "youtube-music": {
    sid: 255,
    sn: Number.parseInt(process.env.MISONOS_YTM_SN ?? "0", 10),
    serviceTokenMagic: 65280,
    descMode: "token"
  }
};

function buildSmapiDidl(
  track: SourceTrackInfo & { id: string },
  smapi: SmapiSourceInfo,
  descMode: "anonymous" | "token" = smapi.descMode ?? "anonymous"
): string {
  // Anonymous-auth services usually use just "SA_RINCON{magic}_"; the
  // _X_#Svc...-0-Token suffix is the DeviceLink/AppLink form seen in captures.
  const desc = descMode === "token"
    ? `SA_RINCON${smapi.serviceTokenMagic}_X_#Svc${smapi.serviceTokenMagic}-0-Token`
    : `SA_RINCON${smapi.serviceTokenMagic}_`;
  const inner =
    `<item id="${escapeXml(track.id)}" parentID="-1" restricted="true">` +
    `<dc:title>${escapeXml(track.title)}</dc:title>` +
    (track.artist ? `<dc:creator>${escapeXml(track.artist)}</dc:creator>` : "") +
    (track.album ? `<upnp:album>${escapeXml(track.album)}</upnp:album>` : "") +
    (track.albumArtUri ? `<upnp:albumArtURI>${escapeXml(track.albumArtUri)}</upnp:albumArtURI>` : "") +
    `<upnp:class>object.item.audioItem.musicTrack</upnp:class>` +
    `<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${escapeXml(desc)}</desc>` +
    `</item>`;
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/">${inner}</DIDL-Lite>`;
}

function buildSmapiUri(
  trackId: string,
  ext: string,
  smapi: SmapiSourceInfo,
  flags: number,
  uriScheme: "x-sonos-http" | "x-sonosapi-stream"
): string {
  const encodedTrackId = encodeURIComponent(trackId);
  if (uriScheme === "x-sonosapi-stream") {
    return `x-sonosapi-stream:${encodedTrackId}?sid=${smapi.sid}&flags=${flags}&sn=${smapi.sn}`;
  }
  return `x-sonos-http:${encodedTrackId}${ext}?sid=${smapi.sid}&flags=${flags}&sn=${smapi.sn}`;
}

function summarizeSmapiScan(results: SmapiAccountScanAttempt[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const result of results) {
    const addCode = result.addUriToQueue.ok ? "queue-ok" : `queue-${result.addUriToQueue.faultCode ?? "error"}`;
    summary[addCode] = (summary[addCode] ?? 0) + 1;
    if (result.play) {
      const playCode = result.play.ok ? "play-ok" : `play-${result.play.faultCode ?? "error"}`;
      summary[playCode] = (summary[playCode] ?? 0) + 1;
    }
    summary[result.outcome] = (summary[result.outcome] ?? 0) + 1;
  }
  return summary;
}

function formatUpnpDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.000`;
}

function urlSafeSlug(value: string): string {
  // Sonos uses the URL basename as a fallback "title" when it can't read
  // embedded file metadata. Make that basename actually look like the song.
  const cleaned = value
    .replace(/[\\/?#]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return encodeURIComponent(cleaned || "track");
}

function extensionForMime(mime: string | undefined): string {
  if (!mime) return ".mp3";
  // Mime can include codec specifiers like `audio/mp4; codecs="mp4a.40.2"`.
  const baseMime = mime.split(";")[0].trim().toLowerCase();
  switch (baseMime) {
    case "audio/mp4":
    case "audio/x-m4a":
      return ".m4a";
    case "audio/aac":
      return ".aac";
    case "audio/webm":
    case "audio/opus":
      return ".webm";
    case "audio/ogg":
      return ".ogg";
    case "audio/flac":
    case "audio/x-flac":
      return ".flac";
    case "audio/mpeg":
      return ".mp3";
    default:
      return ".mp3";
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
