import type { BridgeEvent, BridgeSnapshot, NowPlaying, QueueItem, SonosGroup, SonosZone, TransportAction, VolumePayload, VolumeState } from "@misonos/sonos-protocol";

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
  volume: (zoneId: string, payload: VolumePayload) =>
    request<VolumeState>(`/api/zones/${encodeURIComponent(zoneId)}/volume`, {
      method: "POST",
      body: JSON.stringify(payload)
    })
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
