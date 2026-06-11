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

export type BridgeEvent =
  | { type: "snapshot"; payload: BridgeSnapshot; at: string }
  | { type: "now-playing"; payload: NowPlaying; at: string }
  | { type: "error"; message: string; at: string };
