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
  // Recovered source reference (when the URI maps back to a known source), so the
  // track can be favorited directly from the queue.
  sourceId?: string;
  trackId?: string;
}

export type RepeatMode = "none" | "all" | "one";

// Sonos alarms (AlarmClock service). Household-wide.
export type AlarmRecurrence =
  | "once"
  | "daily"
  | "weekdays"
  | "weekends"
  | { days: number[] }; // 0=Sun … 6=Sat

export type AlarmProgram = "chime" | "queue" | "other";

export interface Alarm {
  id: string;
  startTime: string; // "HH:MM:SS" (speaker local time)
  durationSeconds: number;
  recurrence: AlarmRecurrence;
  enabled: boolean;
  roomUuid: string;
  roomName?: string;
  program: AlarmProgram; // derived from programUri
  programUri: string; // preserved verbatim for round-trip
  programMetaData: string;
  playMode: string;
  volume: number; // 0..100
  includeLinkedZones: boolean;
}

export interface AlarmInput {
  startTime: string; // "HH:MM" or "HH:MM:SS"
  durationSeconds?: number;
  recurrence: AlarmRecurrence;
  enabled: boolean;
  roomUuid: string;
  program: AlarmProgram; // "other" => keep existing programUri (update only)
  programUri?: string;
  programMetaData?: string;
  playMode?: string;
  volume: number; // 0..100
  includeLinkedZones?: boolean;
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
  repeat?: RepeatMode;
  shuffle?: boolean;
  crossfade?: boolean;
  sleepTimerSeconds?: number; // remaining seconds, 0/undefined when off
  isLive?: boolean; // current track is a live, non-seekable stream (internet radio)
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
  albumArtUri?: string;
  // Explicit "live, non-seekable stream" marker (internet radio). Set by the
  // source — never inferred from a missing duration, which normal tracks and
  // podcast episodes can also omit.
  isLive?: boolean;
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
  isLive?: boolean; // live, non-seekable stream (internet radio)
}

// Wire (DTO) shapes for the bridge's writable store. camelCase; distinct from the
// snake_case DB rows, which stay bridge-local. See apps/bridge/src/store.

export interface Preference {
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface RecentlyViewedItem {
  sourceId: string;
  itemId: string;
  kind: SourceItemKind;
  title: string;
  subtitle?: string | null;
  viewedAt: string;
}

export interface EqPreset {
  id: number;
  name: string;
  bass: number; // -10..10
  treble: number; // -10..10
  loudness: boolean;
  createdAt: string;
}

// "radio" marks a live, non-seekable stream (e.g. TuneIn). Only radio favorites
// are eligible to be promoted to a preset.
export type FavoriteKind = "track" | "album" | "radio";

export interface Favorite {
  id: number;
  kind: FavoriteKind;
  sourceId: string;
  itemId: string;
  title: string;
  subtitle?: string | null;
  artist?: string | null;
  album?: string | null;
  albumArtUri?: string | null;
  // A preset is a favorite pinned for one-tap tuning. preset implies favorited;
  // removing the favorite clears the preset. Only radio-kind favorites set this.
  preset: boolean;
  createdAt: string;
}

export interface Playlist {
  id: number;
  name: string;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlaylistItem {
  id: number;
  playlistId: number;
  position: number;
  sourceId: string;
  trackId: string;
  title: string;
  artist?: string | null;
  album?: string | null;
  durationSeconds?: number | null;
  addedAt: string;
}

// Live equalizer state for a single speaker (RenderingControl is per-player, Master channel).
export interface EqState {
  id: string; // zone id
  bass: number; // -10..10
  treble: number; // -10..10
  loudness: boolean;
}

export interface EqPayload {
  bass?: number;
  treble?: number;
  loudness?: boolean;
}

// The tone values a preset applies. Built-in presets carry no DB id/createdAt.
export interface EqPresetValues {
  bass: number;
  treble: number;
  loudness: boolean;
}

export interface BuiltInEqPreset extends EqPresetValues {
  name: string;
}

export const BUILT_IN_EQ_PRESETS: BuiltInEqPreset[] = [
  { name: "Flat", bass: 0, treble: 0, loudness: false },
  { name: "Bass Boost", bass: 6, treble: 0, loudness: false },
  { name: "Treble Boost", bass: 0, treble: 5, loudness: false },
  { name: "Vocal", bass: -2, treble: 3, loudness: false },
  { name: "Late Night", bass: -4, treble: -1, loudness: true },
  { name: "Loudness", bass: 2, treble: 2, loudness: true }
];

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
