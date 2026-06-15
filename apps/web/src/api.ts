import type { Alarm, AlarmInput, BridgeEvent, BridgeSnapshot, BrowseResult, CustomServicePresetView, EqPayload, EqPreset, EqState, Favorite, MusicServiceDiscovery, NowPlaying, PlaybackMode, Playlist, PlaylistItem, Preference, QueueItem, RecentlyViewedItem, RegisterCustomServiceResult, RepeatMode, SonosAccountsResponse, SonosDeviceInfo, SonosGroup, SonosZone, SourceBrowseResponse, SourceDescriptor, SourceItemKind, TransportAction, VolumePayload, VolumeState } from "@misonos/sonos-protocol";

export interface AddPlaylistItemInput {
  id: string;
  kind: SourceItemKind;
  title: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const bridgeApi = {
  discover: () => request<BridgeSnapshot>("/api/discover", { method: "POST", body: "{}" }),
  zones: () => request<SonosZone[]>("/api/zones"),
  groups: () => request<SonosGroup[]>("/api/groups"),
  nowPlaying: (groupId: string) => request<NowPlaying>(`/api/groups/${encodeURIComponent(groupId)}/now-playing`),
  queue: (groupId: string) => request<QueueItem[]>(`/api/groups/${encodeURIComponent(groupId)}/queue`),
  groupVolume: (groupId: string) => request<VolumeState>(`/api/groups/${encodeURIComponent(groupId)}/volume`),
  setGroupVolume: (groupId: string, payload: VolumePayload) =>
    request<VolumeState>(`/api/groups/${encodeURIComponent(groupId)}/volume`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  zoneVolume: (zoneId: string) => request<VolumeState>(`/api/zones/${encodeURIComponent(zoneId)}/volume`),
  zoneEq: (zoneId: string) => request<EqState>(`/api/zones/${encodeURIComponent(zoneId)}/eq`),
  setZoneEq: (zoneId: string, payload: EqPayload) =>
    request<EqState>(`/api/zones/${encodeURIComponent(zoneId)}/eq`, { method: "POST", body: JSON.stringify(payload) }),
  joinZoneToGroup: (zoneId: string, groupId: string) =>
    request<BridgeSnapshot>(`/api/zones/${encodeURIComponent(zoneId)}/join`, {
      method: "POST",
      body: JSON.stringify({ groupId })
    }),
  makeZoneStandalone: (zoneId: string) =>
    request<BridgeSnapshot>(`/api/zones/${encodeURIComponent(zoneId)}/standalone`, {
      method: "POST",
      body: "{}"
    }),
  promoteZoneToCoordinator: (zoneId: string) =>
    request<BridgeSnapshot>(`/api/zones/${encodeURIComponent(zoneId)}/promote`, {
      method: "POST",
      body: "{}"
    }),
  transport: (groupId: string, action: TransportAction) =>
    request<NowPlaying>(`/api/groups/${encodeURIComponent(groupId)}/transport`, {
      method: "POST",
      body: JSON.stringify({ action })
    }),
  playQueueIndex: (groupId: string, index: number) =>
    request<NowPlaying>(`/api/groups/${encodeURIComponent(groupId)}/queue/play-index`, {
      method: "POST",
      body: JSON.stringify({ index })
    }),
  seek: (groupId: string, positionSeconds: number) =>
    request<NowPlaying>(`/api/groups/${encodeURIComponent(groupId)}/seek`, {
      method: "POST",
      body: JSON.stringify({ positionSeconds })
    }),
  setPlayMode: (groupId: string, repeat: RepeatMode, shuffle: boolean) =>
    request<NowPlaying>(`/api/groups/${encodeURIComponent(groupId)}/play-mode`, {
      method: "POST",
      body: JSON.stringify({ repeat, shuffle })
    }),
  setCrossfade: (groupId: string, enabled: boolean) =>
    request<NowPlaying>(`/api/groups/${encodeURIComponent(groupId)}/crossfade`, {
      method: "POST",
      body: JSON.stringify({ enabled })
    }),
  setSleepTimer: (groupId: string, seconds: number) =>
    request<NowPlaying>(`/api/groups/${encodeURIComponent(groupId)}/sleep-timer`, {
      method: "POST",
      body: JSON.stringify({ seconds })
    }),
  alarms: () => request<Alarm[]>("/api/alarms"),
  createAlarm: (body: AlarmInput) =>
    request<Alarm[]>("/api/alarms", { method: "POST", body: JSON.stringify(body) }),
  updateAlarm: (id: string, body: AlarmInput) =>
    request<Alarm[]>(`/api/alarms/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(body) }),
  deleteAlarm: (id: string) =>
    request<Alarm[]>(`/api/alarms/${encodeURIComponent(id)}/delete`, { method: "POST", body: "{}" }),
  volume: (zoneId: string, payload: VolumePayload) =>
    request<VolumeState>(`/api/zones/${encodeURIComponent(zoneId)}/volume`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  devices: () => request<SonosDeviceInfo[]>("/api/devices"),
  musicServices: () => request<MusicServiceDiscovery>("/api/music/services"),
  listSources: () => request<SourceDescriptor[]>("/api/sources"),
  browseSource: (sourceId: string, id?: string) => {
    const query = id ? `?id=${encodeURIComponent(id)}` : "";
    return request<SourceBrowseResponse>(`/api/sources/${encodeURIComponent(sourceId)}/browse${query}`);
  },
  searchSource: (sourceId: string, query: string, type?: string) => {
    const typeParam = type ? `&type=${encodeURIComponent(type)}` : "";
    return request<SourceBrowseResponse>(`/api/sources/${encodeURIComponent(sourceId)}/search?q=${encodeURIComponent(query)}${typeParam}`);
  },
  sourceAuthStatus: (sourceId: string) =>
    request<{ state: "signed-out" | "pending" | "signed-in"; verificationUrl?: string; userCode?: string; expiresAt?: number }>(`/api/sources/${encodeURIComponent(sourceId)}/auth/status`),
  sourceAuthStart: (sourceId: string) =>
    request<{ state: "signed-out" | "pending" | "signed-in"; verificationUrl?: string; userCode?: string; expiresAt?: number }>(`/api/sources/${encodeURIComponent(sourceId)}/auth/start`, { method: "POST", body: "{}" }),
  sourceAuthSignOut: (sourceId: string) =>
    request<{ state: "signed-out" }>(`/api/sources/${encodeURIComponent(sourceId)}/auth/signout`, { method: "POST", body: "{}" }),
  playSourceItems: (sourceId: string, body: { trackIds: string[]; groupId: string; mode: PlaybackMode }) =>
    request<NowPlaying>(`/api/sources/${encodeURIComponent(sourceId)}/play`, { method: "POST", body: JSON.stringify(body) }),
  customServicePresets: () => request<CustomServicePresetView[]>("/api/music/custom-presets"),
  registerCustomService: (body: { presetId: string; zoneId: string; hostOverride?: string; uriOverride?: string; secureUri?: string }) =>
    request<RegisterCustomServiceResult>("/api/music/custom-presets/register", { method: "POST", body: JSON.stringify(body) }),
  sonosAccounts: () => request<SonosAccountsResponse>("/api/music/accounts"),
  musicBrowse: (body: { objectId: string; startingIndex?: number; requestedCount?: number; filter?: string; sortCriteria?: string }) =>
    request<BrowseResult>("/api/music/browse", { method: "POST", body: JSON.stringify(body) }),
  musicSearch: (body: { containerId: string; searchCriteria: string; startingIndex?: number; requestedCount?: number; filter?: string; sortCriteria?: string }) =>
    request<BrowseResult>("/api/music/search", { method: "POST", body: JSON.stringify(body) }),
  getPreference: (key: string) =>
    request<Preference>(`/api/preferences/${encodeURIComponent(key)}`),
  setPreference: (key: string, value: unknown) =>
    request<Preference>(`/api/preferences/${encodeURIComponent(key)}`, { method: "POST", body: JSON.stringify({ value }) }),
  recentlyViewed: (sourceId?: string, limit?: number) => {
    const params = new URLSearchParams();
    if (sourceId) params.set("sourceId", sourceId);
    if (limit) params.set("limit", String(limit));
    const query = params.toString();
    return request<RecentlyViewedItem[]>(`/api/recently-viewed${query ? `?${query}` : ""}`);
  },
  recordRecentlyViewed: (item: Omit<RecentlyViewedItem, "viewedAt">) =>
    request<void>("/api/recently-viewed", { method: "POST", body: JSON.stringify(item) }),
  eqPresets: () => request<EqPreset[]>("/api/eq-presets"),
  createEqPreset: (input: Omit<EqPreset, "id" | "createdAt">) =>
    request<EqPreset>("/api/eq-presets", { method: "POST", body: JSON.stringify(input) }),
  deleteEqPreset: (id: number) =>
    request<void>("/api/eq-presets/delete", { method: "POST", body: JSON.stringify({ id }) }),
  favorites: () => request<Favorite[]>("/api/favorites"),
  addFavorite: (favorite: Omit<Favorite, "id" | "createdAt">) =>
    request<Favorite>("/api/favorites", { method: "POST", body: JSON.stringify(favorite) }),
  removeFavorite: (sourceId: string, itemId: string) =>
    request<void>("/api/favorites/delete", { method: "POST", body: JSON.stringify({ sourceId, itemId }) }),
  playlists: () => request<Playlist[]>("/api/playlists"),
  playlist: (id: number) => request<{ playlist: Playlist; items: PlaylistItem[] }>(`/api/playlists/${id}`),
  createPlaylist: (name: string) =>
    request<Playlist>("/api/playlists", { method: "POST", body: JSON.stringify({ name }) }),
  renamePlaylist: (id: number, name: string) =>
    request<Playlist>(`/api/playlists/${id}/rename`, { method: "POST", body: JSON.stringify({ name }) }),
  deletePlaylist: (id: number) =>
    request<void>("/api/playlists/delete", { method: "POST", body: JSON.stringify({ id }) }),
  addPlaylistItems: (id: number, sourceId: string, items: AddPlaylistItemInput[]) =>
    request<{ added: PlaylistItem[]; skipped: number }>(`/api/playlists/${id}/items`, { method: "POST", body: JSON.stringify({ sourceId, items }) }),
  removePlaylistItem: (id: number, itemId: number) =>
    request<void>(`/api/playlists/${id}/items/remove`, { method: "POST", body: JSON.stringify({ itemId }) }),
  reorderPlaylist: (id: number, orderedItemIds: number[]) =>
    request<PlaylistItem[]>(`/api/playlists/${id}/reorder`, { method: "POST", body: JSON.stringify({ orderedItemIds }) }),
  playPlaylist: (id: number, groupId: string, mode: PlaybackMode) =>
    request<NowPlaying>(`/api/playlists/${id}/play`, { method: "POST", body: JSON.stringify({ groupId, mode }) }),
  savePlaylistFromQueue: (name: string, groupId: string) =>
    request<{ playlist: Playlist; saved: number; skipped: number }>("/api/playlists/from-queue", { method: "POST", body: JSON.stringify({ name, groupId }) })
};

export function subscribeBridgeEvents(onEvent: (event: BridgeEvent) => void, onError: () => void): () => void {
  const source = new EventSource("/api/events");
  const handler = (message: MessageEvent<string>) => onEvent(JSON.parse(message.data) as BridgeEvent);
  source.addEventListener("snapshot", handler as EventListener);
  source.addEventListener("now-playing", handler as EventListener);
  source.addEventListener("error", handler as EventListener);
  source.onerror = onError;
  return () => source.close();
}
