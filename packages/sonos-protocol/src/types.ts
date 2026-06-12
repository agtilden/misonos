export type TransportAction = "play" | "pause" | "stop" | "next" | "previous";

export type PlaybackState =
  | "PLAYING"
  | "PAUSED_PLAYBACK"
  | "STOPPED"
  | "TRANSITIONING"
  | "NO_MEDIA_PRESENT"
  | "UNKNOWN";

export interface SonosZone {
  id: string;
  uuid: string;
  name: string;
  ipAddress: string;
  location: string;
  coordinatorId?: string;
  groupId?: string;
  visible: boolean;
}

export interface SonosGroup {
  id: string;
  coordinatorId: string;
  coordinatorName: string;
  zones: SonosZone[];
}

export interface QueueItem {
  id: string;
  parentId?: string;
  title: string;
  artist?: string;
  album?: string;
  albumArtUri?: string;
  uri?: string;
  itemClass?: string;
}

export interface NowPlaying {
  groupId: string;
  state: PlaybackState;
  title: string;
  artist?: string;
  album?: string;
  albumArtUri?: string;
  duration?: string;
  position?: string;
  playlistPosition?: number;
  uri?: string;
  updatedAt: string;
}

export interface VolumePayload {
  volume?: number;
  delta?: number;
  muted?: boolean;
}

export interface VolumeState {
  id: string;
  volume: number;
  muted: boolean;
}

export interface BridgeSnapshot {
  zones: SonosZone[];
  groups: SonosGroup[];
}

export interface MusicServiceDescriptor {
  id: number;
  name: string;
  version?: string;
  uri?: string;
  secureUri?: string;
  containerType?: string;
  capabilities?: string;
  authType?: string;
  pollInterval?: string;
  manifestUri?: string;
}

export interface MusicServiceDiscovery {
  services: MusicServiceDescriptor[];
  youtubeMusic?: MusicServiceDescriptor;
  session?: {
    serviceId: number;
    sessionId?: string;
    username?: string;
    error?: string;
  };
  fetchedAt: string;
}

export interface SonosAccount {
  type: number;
  serialNum?: string;
  username?: string;
  metadata?: string;
  nickname?: string;
  oaDeviceId?: string;
  key?: string;
}

export interface SonosAccountsResponse {
  accounts: SonosAccount[];
  raw: string;
  fetchedAt: string;
}

export interface BrowseResult {
  raw: string;
  items: QueueItem[];
  numberReturned?: string;
  totalMatches?: string;
}

export interface CustomServicePresetView {
  id: string;
  name: string;
  description: string;
  port: number;
  path?: string;
  authType: "Anonymous" | "UserId" | "DeviceLink" | "AppLink";
  pollInterval: number;
  containerType: string;
  capabilities?: string;
  presentationMapUri?: string;
  stringsUri?: string;
  uri: string | null;
  detectedHostIp: string | null;
}

export interface RegisterCustomServiceResult {
  status: number;
  body: string;
  attemptedUri: string;
  speakerIp: string;
  accountType?: string;
  accountUdn?: string;
  accountError?: string;
  refreshError?: string;
}

export interface SourceDescriptor {
  id: string;
  name: string;
  description?: string;
  rootId: string;
  baseUrl?: string;
  capabilities?: string[];
}

export type SourceItemKind = "container" | "album" | "playable" | "section";

export interface SourceBrowseItem {
  id: string;
  title: string;
  kind: SourceItemKind;
  subtitle?: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
}

export type PlaybackMode = "replace" | "next" | "end";

export interface SourceBrowseResponse {
  id: string;
  items: SourceBrowseItem[];
  total: number;
  title?: string;
}

export interface SourceTrackInfo {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
  albumArtUri?: string;
  url: string;
  mimeType?: string;
}

export interface SonosDeviceInfo {
  uuid: string;
  zoneName: string;
  roomName: string;
  modelName?: string;
  displayName?: string;
  modelNumber?: string;
  serialNumber?: string;
  softwareVersion?: string;
  softwareDate?: string;
  swGen?: string;
  minCompatibleVersion?: string;
  hardwareVersion?: string;
  dspVersion?: string;
  ipAddress: string;
  macAddress?: string;
  extraInfo?: string;
  householdId?: string;
  fetchedAt: string;
}

export type BridgeEvent =
  | { type: "snapshot"; payload: BridgeSnapshot; at: string }
  | { type: "now-playing"; payload: NowPlaying; at: string }
  | { type: "error"; message: string; at: string };
