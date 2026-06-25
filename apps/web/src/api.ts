import type { Alarm, AlarmInput, BridgeEvent, BridgeSnapshot, BrowseResult, CustomServicePresetView, EqPayload, EqPreset, EqState, Favorite, MusicServiceDiscovery, NowPlaying, PlaybackMode, Playlist, PlaylistItem, Preference, QueueItem, RecentlyPlayedItem, RecentlyViewedItem, RecentQueue, RegisterCustomServiceResult, RepeatMode, SonosAccountsResponse, SonosDeviceInfo, SonosGroup, SonosZone, SourceBrowseResponse, SourceDescriptor, SourceItemKind, TransportAction, VolumePayload, VolumeState } from "@misonos/sonos-protocol";
import { apiUrl } from "./servers.js";

export interface AddPlaylistItemInput {
  id: string;
  kind: SourceItemKind;
  title: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
}

async function request<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  // Use only CORS-"simple" request headers so a call to a switched-to backend never
  // triggers a preflight (OPTIONS). Cross-origin preflights fail against the other
  // host, which broke every fetch-based load after switching locations, while the
  // preflight-free SSE stream kept working. The bridge parses bodies with JSON.parse
  // regardless of Content-Type, so text/plain (a simple type) is safe; callers that set
  // their own type (e.g. icon upload) keep it.
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "text/plain;charset=UTF-8");
  }
  // Without a deadline, a backend that accepts the connection but never answers (a
  // wedged process, a half-open socket after a reboot, an unreachable switched-to
  // host) leaves the await pending forever — so the UI hangs in "loading" with no
  // error. Bound the snapshot calls so a stall surfaces as an error the user can
  // retry. Callers that pass their own signal keep it; only opt-in callers get a timeout.
  const signal = init?.signal ?? (timeoutMs != null ? AbortSignal.timeout(timeoutMs) : undefined);
  let response: Response;
  try {
    response = await fetch(apiUrl(path), { ...init, headers, signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("Bridge did not respond — it may be offline or unreachable.");
    }
    throw error;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// Resolve album art to a renderable `<img src>`. Absolute http(s) art — notably
// YouTube Music's yt3 CDN — gets hotlink-throttled when a search/browse loads ~20
// thumbnails at once, so route it through the bridge's caching `/api/art` proxy.
// data: URIs pass through unchanged. Anything routed to (or already on) the bridge —
// the `/api/art` wrapper, plus any root-relative path — is resolved against the
// selected backend so art loads from the same host as the rest of the API after
// switching locations (see servers.ts).
export function artSrc(uri?: string | null): string | undefined {
  if (!uri) return undefined;
  if (/^https?:\/\//i.test(uri)) return apiUrl(`/api/art?u=${encodeURIComponent(uri)}`);
  return uri.startsWith("/") ? apiUrl(uri) : uri;
}

export const bridgeApi = {
  // 15s comfortably exceeds the bridge's bounded discovery sweep (~11s worst case)
  // while still converting a never-answering backend into a retryable error.
  discover: () => request<BridgeSnapshot>("/api/discover", { method: "POST", body: "{}" }, 15_000),
  zones: () => request<SonosZone[]>("/api/zones", undefined, 15_000),
  groups: () => request<SonosGroup[]>("/api/groups", undefined, 15_000),
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
  clearQueue: (groupId: string) =>
    request<QueueItem[]>(`/api/groups/${encodeURIComponent(groupId)}/queue/clear`, { method: "POST", body: "{}" }),
  reorderQueueTrack: (groupId: string, fromIndex: number, toIndex: number) =>
    request<QueueItem[]>(`/api/groups/${encodeURIComponent(groupId)}/queue/reorder`, {
      method: "POST",
      body: JSON.stringify({ fromIndex, toIndex })
    }),
  removeQueueTrack: (groupId: string, index: number) =>
    request<QueueItem[]>(`/api/groups/${encodeURIComponent(groupId)}/queue/remove`, {
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
    request<{ cookieAuth?: "signed-in" | "signed-out" }>(`/api/sources/${encodeURIComponent(sourceId)}/auth/status`),
  sourceAuthSetCookies: (sourceId: string, paste: string) =>
    request<{ cookieAuth: "signed-in" | "signed-out" }>(`/api/sources/${encodeURIComponent(sourceId)}/auth/cookies`, { method: "POST", body: JSON.stringify({ paste }) }),
  sourceAuthClearCookies: (sourceId: string) =>
    request<{ cookieAuth: "signed-out" }>(`/api/sources/${encodeURIComponent(sourceId)}/auth/cookies/clear`, { method: "POST", body: "{}" }),
  sourceSubscriptions: (sourceId: string) =>
    request<{ ids: string[] }>(`/api/sources/${encodeURIComponent(sourceId)}/subscriptions`),
  pinSource: (sourceId: string, id: string, pinned: boolean) =>
    request<{ pinned: boolean }>(`/api/sources/${encodeURIComponent(sourceId)}/pin`, { method: "POST", body: JSON.stringify({ id, pinned }) }),
  playSourceItems: (sourceId: string, body: { trackIds: string[]; groupId: string; mode: PlaybackMode; autoplay?: boolean }) =>
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
  recentlyPlayed: (limit?: number) =>
    request<RecentlyPlayedItem[]>(`/api/recently-played${limit ? `?limit=${limit}` : ""}`),
  playRecentlyPlayed: (groupId: string, mode: PlaybackMode) =>
    request<NowPlaying>("/api/recently-played/play", { method: "POST", body: JSON.stringify({ groupId, mode }) }),
  removeRecentlyPlayed: (sourceId: string, trackId: string) =>
    request<void>("/api/recently-played/remove", { method: "POST", body: JSON.stringify({ sourceId, trackId }) }),
  clearRecentlyPlayed: () =>
    request<void>("/api/recently-played/clear", { method: "POST", body: "{}" }),
  eqPresets: () => request<EqPreset[]>("/api/eq-presets"),
  createEqPreset: (input: Omit<EqPreset, "id" | "createdAt">) =>
    request<EqPreset>("/api/eq-presets", { method: "POST", body: JSON.stringify(input) }),
  deleteEqPreset: (id: number) =>
    request<void>("/api/eq-presets/delete", { method: "POST", body: JSON.stringify({ id }) }),
  favorites: () => request<Favorite[]>("/api/favorites"),
  addFavorite: (favorite: Omit<Favorite, "id" | "createdAt" | "preset">) =>
    request<Favorite>("/api/favorites", { method: "POST", body: JSON.stringify(favorite) }),
  removeFavorite: (sourceId: string, itemId: string) =>
    request<void>("/api/favorites/delete", { method: "POST", body: JSON.stringify({ sourceId, itemId }) }),
  setFavoritePreset: (sourceId: string, itemId: string, preset: boolean) =>
    request<void>("/api/favorites/preset", { method: "POST", body: JSON.stringify({ sourceId, itemId, preset }) }),
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
  playPlaylist: (id: number, groupId: string, mode: PlaybackMode, fromStart = false) =>
    request<NowPlaying>(`/api/playlists/${id}/play`, { method: "POST", body: JSON.stringify({ groupId, mode, fromStart }) }),
  savePlaylistFromQueue: (name: string, groupId: string) =>
    request<{ playlist: Playlist; saved: number; skipped: number }>("/api/playlists/from-queue", { method: "POST", body: JSON.stringify({ name, groupId }) }),
  recentQueues: (coordinatorUuid: string) =>
    request<RecentQueue[]>(`/api/zones/${encodeURIComponent(coordinatorUuid)}/recent-queues`),
  restoreRecentQueue: (id: number, groupId: string) =>
    request<NowPlaying>(`/api/recent-queues/${id}/restore`, { method: "POST", body: JSON.stringify({ groupId }) }),
  deleteRecentQueue: (id: number) =>
    request<void>(`/api/recent-queues/${id}/dismiss`, { method: "POST", body: "{}" }),
  sourceIcons: () => request<SourceIconMeta[]>("/api/source-icons"),
  uploadSourceIcon: (sourceId: string, file: File) =>
    request<SourceIconMeta>(`/api/source-icons/${encodeURIComponent(sourceId)}`, {
      method: "POST",
      body: file,
      // Send the raw image bytes; override the JSON default content type.
      headers: { "Content-Type": file.type || "application/octet-stream" }
    }),
  deleteSourceIcon: (sourceId: string) =>
    request<void>(`/api/source-icons/${encodeURIComponent(sourceId)}/delete`, { method: "POST", body: "{}" })
};

export interface SourceIconMeta {
  sourceId: string;
  ext: string;
  updatedAt: string;
}

export function subscribeBridgeEvents(onEvent: (event: BridgeEvent) => void, onError: () => void): () => void {
  const source = new EventSource(apiUrl("/api/events"));
  const handler = (message: MessageEvent<string>) => onEvent(JSON.parse(message.data) as BridgeEvent);
  source.addEventListener("snapshot", handler as EventListener);
  source.addEventListener("now-playing", handler as EventListener);
  source.addEventListener("error", handler as EventListener);
  source.onerror = onError;
  return () => source.close();
}
