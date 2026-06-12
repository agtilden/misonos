import type { BridgeEvent, BridgeSnapshot, BrowseResult, CustomServicePresetView, MusicServiceDiscovery, NowPlaying, PlaybackMode, QueueItem, RegisterCustomServiceResult, SonosAccountsResponse, SonosDeviceInfo, SonosGroup, SonosZone, SourceBrowseResponse, SourceDescriptor, TransportAction, VolumePayload, VolumeState } from "@misonos/sonos-protocol";

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
  return response.json() as Promise<T>;
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
    request<BrowseResult>("/api/music/search", { method: "POST", body: JSON.stringify(body) })
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
