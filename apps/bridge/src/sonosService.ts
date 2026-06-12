import { firstDidlItem, parseDidlItems, type BridgeSnapshot, type NowPlaying, type PlaybackState, type QueueItem, type SonosGroup, type SonosZone, type TransportAction, type VolumePayload, type VolumeState } from "@misonos/sonos-protocol";
import { loadConfig, type BridgeConfig } from "./config.js";
import { discoverSsdp } from "./ssdp.js";
import { callSoap } from "./sonosSoap.js";
import { fetchDeviceInfo } from "./deviceInfo.js";
import type { PlaybackMode, SonosDeviceInfo, SourceBrowseResponse, SourceDescriptor, SourceTrackInfo } from "@misonos/sonos-protocol";
import { browseSource, fetchTrack, listSources, searchSource } from "./sources.js";
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

  searchSource(sourceId: string, query: string): Promise<SourceBrowseResponse> {
    return searchSource(sourceId, query);
  }

  fetchSourceTrack(sourceId: string, id: string): Promise<SourceTrackInfo> {
    return fetchTrack(sourceId, id);
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
      // Add in reverse so the first selected track lands immediately after the current track
      for (const item of [...queueItems].reverse()) {
        await callSoap(coordinator.ipAddress, "AVTransport", "AddURIToQueue", {
          InstanceID: 0,
          EnqueuedURI: item.uri,
          EnqueuedURIMetaData: item.metadata,
          DesiredFirstTrackNumberEnqueued: 0,
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
  const inner =
    `<item id="${escapeXml(track.id)}" parentID="-1" restricted="true">` +
    `<dc:title>${escapeXml(track.title)}</dc:title>` +
    (track.artist ? `<dc:creator>${escapeXml(track.artist)}</dc:creator>` : "") +
    (track.album ? `<upnp:album>${escapeXml(track.album)}</upnp:album>` : "") +
    `<res protocolInfo="${protocolInfo}">${escapeXml(track.url)}</res>` +
    `<upnp:class>object.item.audioItem.musicTrack</upnp:class>` +
    `</item>`;
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${inner}</DIDL-Lite>`;
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
