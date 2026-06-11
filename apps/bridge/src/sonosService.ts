import { firstDidlItem, parseDidlItems, type BridgeSnapshot, type NowPlaying, type PlaybackState, type QueueItem, type SonosGroup, type SonosZone, type TransportAction, type VolumePayload, type VolumeState } from "@misonos/sonos-protocol";
import { loadConfig, type BridgeConfig } from "./config.js";
import { discoverSsdp } from "./ssdp.js";
import { callSoap } from "./sonosSoap.js";
import { parseZoneGroupState, zoneFromDeviceDescription } from "./topology.js";

export class SonosService {
  private zones = new Map<string, SonosZone>();
  private groups = new Map<string, SonosGroup>();
  private lastDiscovery = 0;

  constructor(private readonly config: BridgeConfig = loadConfig()) {}

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
  }

  async queue(groupId: string): Promise<QueueItem[]> {
    const group = await this.requireGroup(groupId);
    const coordinator = await this.requireZone(group.coordinatorId);
    const response = await callSoap(coordinator.ipAddress, "ContentDirectory", "Browse", {
      ObjectID: "Q:0",
      BrowseFlag: "BrowseDirectChildren",
      Filter: "*",
      StartingIndex: 0,
      RequestedCount: 100,
      SortCriteria: ""
    });
    return parseDidlItems(response.Result, `http://${coordinator.ipAddress}:1400`);
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
    const [volume, mute] = await Promise.all([
      callSoap(coordinator.ipAddress, "GroupRenderingControl", "GetGroupVolume", { InstanceID: 0 }),
      callSoap(coordinator.ipAddress, "GroupRenderingControl", "GetGroupMute", { InstanceID: 0 })
    ]);
    return {
      id: group.id,
      volume: clampVolume(Number.parseInt(volume.CurrentVolume ?? "0", 10)),
      muted: mute.CurrentMute === "1"
    };
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

  async makeZoneStandalone(zoneId: string): Promise<BridgeSnapshot> {
    const zone = await this.requireZone(zoneId);
    await callSoap(zone.ipAddress, "AVTransport", "BecomeCoordinatorOfStandaloneGroup", {
      InstanceID: 0
    });
    await sleep(1200);
    return this.discover();
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
