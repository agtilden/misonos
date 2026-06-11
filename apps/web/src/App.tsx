import { Pause, Play, RefreshCw, SkipBack, SkipForward, Square, Volume2, VolumeX } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BridgeSnapshot, NowPlaying, QueueItem, SonosGroup, TransportAction, VolumeState } from "@misonos/sonos-protocol";
import { bridgeApi, subscribeBridgeEvents } from "./api.js";

const GroupEditor = lazy(() => import("./GroupEditor.js").then((module) => ({ default: module.GroupEditor })));

type LoadState = "idle" | "loading" | "ready" | "error";
type QueueState = "idle" | "loading" | "ready" | "error";
type PendingGroupEdit =
  | { id: string; type: "join"; zoneId: string; groupId: string }
  | { id: string; type: "standalone"; zoneId: string };

export function App() {
  const [groups, setGroups] = useState<SonosGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueState, setQueueState] = useState<QueueState>("idle");
  const [queueError, setQueueError] = useState<string>("");
  const [zoneVolumes, setZoneVolumes] = useState<Record<string, VolumeState>>({});
  const [groupVolume, setGroupVolume] = useState<VolumeState | null>(null);
  const [volumePopoverOpen, setVolumePopoverOpen] = useState(false);
  const [playbackTick, setPlaybackTick] = useState(0);
  const [groupEditBusy, setGroupEditBusy] = useState(false);
  const [pendingGroupEdits, setPendingGroupEdits] = useState<PendingGroupEdit[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const [message, setMessage] = useState("Ready");
  const groupEditQueueRef = useRef<PendingGroupEdit[]>([]);
  const groupEditProcessingRef = useRef(false);

  const displayGroups = useMemo(
    () => applyPendingGroupEdits(groups, pendingGroupEdits),
    [groups, pendingGroupEdits]
  );

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) ?? groups[0],
    [groups, selectedGroupId]
  );

  const selectedPrimaryZone = useMemo(
    () => selectedGroup?.zones.find((zone) => zone.uuid === selectedGroup.coordinatorId) ?? selectedGroup?.zones[0],
    [selectedGroup]
  );

  const primaryVolume = useMemo(() => {
    if (!selectedGroup) return null;
    if (selectedGroup.zones.length > 1 && groupVolume) return groupVolume;
    return selectedPrimaryZone ? zoneVolumes[selectedPrimaryZone.id] ?? null : null;
  }, [groupVolume, selectedGroup, selectedPrimaryZone, zoneVolumes]);

  const primaryVolumeLabel = selectedGroup && selectedGroup.zones.length > 1
    ? `${selectedGroup.coordinatorName} group`
    : selectedPrimaryZone?.name ?? "Selected room";

  const playbackProgress = useMemo(
    () => playbackProgressFromNowPlaying(nowPlaying, playbackTick),
    [nowPlaying, playbackTick]
  );

  const applySnapshot = useCallback((snapshot: BridgeSnapshot) => {
    setGroups((current) => (groupsTopologyKey(current) === groupsTopologyKey(snapshot.groups) ? current : snapshot.groups));
    setSelectedGroupId((current) => {
      if (current && snapshot.groups.some((group) => group.id === current)) return current;
      return snapshot.groups[0]?.id || "";
    });
  }, []);

  const loadNowPlaying = useCallback(async (groupId: string) => {
    setNowPlaying(await bridgeApi.nowPlaying(groupId));
  }, []);

  const loadQueue = useCallback(async (groupId: string) => {
    setQueueState("loading");
    setQueueError("");
    try {
      setQueue(await bridgeApi.queue(groupId));
      setQueueState("ready");
    } catch (error) {
      setQueueState("error");
      setQueueError(error instanceof Error ? error.message : "Could not load queue");
    }
  }, []);

  const loadVolumes = useCallback(async (group: SonosGroup) => {
    const [nextGroupVolume, nextZoneVolumes] = await Promise.all([
      group.zones.length > 1 ? bridgeApi.groupVolume(group.id).catch(() => null) : Promise.resolve(null),
      Promise.all(group.zones.map((zone) => bridgeApi.zoneVolume(zone.id).catch(() => null)))
    ]);
    setGroupVolume(nextGroupVolume);
    setZoneVolumes((current) => {
      const next = { ...current };
      for (const volume of nextZoneVolumes) {
        if (volume) next[volume.id] = volume;
      }
      return next;
    });
  }, []);

  const loadSnapshot = useCallback(async (force = false) => {
    setState("loading");
    try {
      const snapshot = force ? await bridgeApi.discover() : { groups: await bridgeApi.groups(), zones: await bridgeApi.zones() };
      applySnapshot(snapshot);
      setState("ready");
      setMessage(snapshot.groups.length ? "Connected over LAN" : "No Sonos groups found");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Bridge unavailable");
    }
  }, [applySnapshot]);

  useEffect(() => {
    void loadSnapshot(true);
  }, [loadSnapshot]);

  useEffect(() => {
    if (!selectedGroupId) return;
    setVolumePopoverOpen(false);
    void loadNowPlaying(selectedGroupId);
    void loadQueue(selectedGroupId);
  }, [loadNowPlaying, loadQueue, selectedGroupId]);

  useEffect(() => {
    if (!selectedGroup) return;
    void loadVolumes(selectedGroup);
  }, [loadVolumes, selectedGroup]);

  useEffect(() => {
    if (!selectedGroup?.id) return undefined;
    const groupId = selectedGroup.id;
    const timer = window.setInterval(() => {
      void loadNowPlaying(groupId);
      void loadVolumes(selectedGroup);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [loadNowPlaying, loadVolumes, selectedGroup]);

  useEffect(() => subscribeBridgeEvents((event) => {
    if (event.type === "snapshot") applySnapshot(event.payload);
    if (event.type === "now-playing" && event.payload.groupId === selectedGroup?.id) setNowPlaying(event.payload);
    if (event.type === "error") setMessage(event.message);
  }, () => setMessage("Bridge event stream disconnected")), [applySnapshot, selectedGroup?.id]);

  useEffect(() => {
    setPlaybackTick(Date.now());
    if (nowPlaying?.state !== "PLAYING") return undefined;
    const timer = window.setInterval(() => setPlaybackTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [nowPlaying]);

  const runTransport = async (action: TransportAction) => {
    if (!selectedGroup) return;
    setNowPlaying(await bridgeApi.transport(selectedGroup.id, action));
    void loadNowPlaying(selectedGroup.id);
  };

  const setZoneVolume = async (zoneId: string, volume: number) => {
    const next = await bridgeApi.volume(zoneId, { volume });
    setZoneVolumes((current) => ({ ...current, [next.id]: next }));
  };

  const toggleZoneMute = async (zoneId: string) => {
    const current = zoneVolumes[zoneId];
    const next = await bridgeApi.volume(zoneId, { muted: !current?.muted });
    setZoneVolumes((existing) => ({ ...existing, [next.id]: next }));
  };

  const setSelectedGroupVolume = async (volume: number) => {
    if (!selectedGroup) return;
    setGroupVolume(await bridgeApi.setGroupVolume(selectedGroup.id, { volume }));
    void loadVolumes(selectedGroup);
  };

  const toggleGroupMute = async () => {
    if (!selectedGroup || !groupVolume) return;
    setGroupVolume(await bridgeApi.setGroupVolume(selectedGroup.id, { muted: !groupVolume.muted }));
    void loadVolumes(selectedGroup);
  };

  const setPrimaryVolume = async (volume: number) => {
    if (!selectedGroup) return;
    if (selectedGroup.zones.length > 1) {
      await setSelectedGroupVolume(volume);
    } else if (selectedPrimaryZone) {
      await setZoneVolume(selectedPrimaryZone.id, volume);
    }
  };

  const togglePrimaryMute = async () => {
    if (!selectedGroup) return;
    if (selectedGroup.zones.length > 1) {
      await toggleGroupMute();
    } else if (selectedPrimaryZone) {
      await toggleZoneMute(selectedPrimaryZone.id);
    }
  };

  const playQueueItem = async (index: number) => {
    if (!selectedGroup) return;
    setNowPlaying(await bridgeApi.playQueueIndex(selectedGroup.id, index));
    void loadNowPlaying(selectedGroup.id);
  };

  const makeZoneStandalone = async (zoneId: string) => {
    enqueueGroupEdit({ id: crypto.randomUUID(), type: "standalone", zoneId });
  };

  const processGroupEditQueue = useCallback(async () => {
    if (groupEditProcessingRef.current) return;
    const next = groupEditQueueRef.current.shift();
    if (!next) {
      setGroupEditBusy(false);
      return;
    }
    groupEditProcessingRef.current = true;
    setGroupEditBusy(true);
    try {
      const snapshot = next.type === "join"
        ? await bridgeApi.joinZoneToGroup(next.zoneId, next.groupId)
        : await bridgeApi.makeZoneStandalone(next.zoneId);
      applySnapshot(snapshot);
      if (next.type === "join") setSelectedGroupId(next.groupId);
      setMessage(next.type === "join" ? "Group updated" : "Room split into its own group");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update group");
    } finally {
      setPendingGroupEdits((current) => current.filter((edit) => edit.id !== next.id));
      groupEditProcessingRef.current = false;
      void processGroupEditQueue();
    }
  }, [applySnapshot]);

  const enqueueGroupEdit = useCallback((edit: PendingGroupEdit) => {
    groupEditQueueRef.current.push(edit);
    setPendingGroupEdits((current) => [...current, edit]);
    void processGroupEditQueue();
  }, [processGroupEditQueue]);

  const joinZoneToGroup = async (zoneId: string, groupId: string) => {
    if (isOptimisticGroupId(groupId)) return;
    enqueueGroupEdit({ id: crypto.randomUUID(), type: "join", zoneId, groupId });
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">MiSonos</p>
          <h1>LAN Controller</h1>
        </div>
        <div className="status">
          <span className={`status-dot ${state}`} />
          <span>{message}</span>
          <button className="icon-button" type="button" title="Rediscover speakers" aria-label="Rediscover speakers" onClick={() => void loadSnapshot(true)}>
            <RefreshCw size={18} />
          </button>
        </div>
      </header>

      <section className="controller-grid">
        <aside className="sidebar" aria-label="Groups">
          <div className="section-heading">
            <h2>Groups</h2>
            <span>{displayGroups.length}</span>
          </div>
          {displayGroups.length === 0 ? (
            <div className="empty-panel">Start the bridge on the same LAN as your speakers.</div>
          ) : (
            <div className="group-list">
              {displayGroups.map((group) => (
                <button
                  type="button"
                  key={group.id}
                  className={`${group.id === selectedGroup?.id ? "group-row active" : "group-row"}${isOptimisticGroupId(group.id) ? " pending" : ""}`}
                  onClick={() => {
                    if (!isOptimisticGroupId(group.id)) setSelectedGroupId(group.id);
                  }}
                >
                  <span>{group.coordinatorName}</span>
                  <small>{group.zones.map((zone) => zone.name).join(" + ")}</small>
                </button>
              ))}
            </div>
          )}
        </aside>

        <Suspense fallback={<section className="group-editor-panel"><div className="empty-panel">Loading group editor...</div></section>}>
          <GroupEditor
            groups={displayGroups}
            selectedGroupId={selectedGroup?.id}
            busy={groupEditBusy}
            onSelectGroup={setSelectedGroupId}
            onJoinZoneGroup={(zoneId, groupId) => void joinZoneToGroup(zoneId, groupId)}
            onUngroupZone={(zoneId) => void makeZoneStandalone(zoneId)}
          />
        </Suspense>

        <section className="now-playing" aria-label="Now playing">
          <div className="artwork-frame">
            {nowPlaying?.albumArtUri ? <img src={nowPlaying.albumArtUri} alt="" /> : <div className="artwork-fallback">Mi</div>}
          </div>
          <div className="track-copy">
            <p className="eyebrow">{nowPlaying?.state ?? "UNKNOWN"}</p>
            <h2>{nowPlaying?.title ?? "Nothing selected"}</h2>
            <p>{[nowPlaying?.artist, nowPlaying?.album].filter(Boolean).join(" - ") || "Choose a group to load playback state."}</p>
            <div className="progress-copy">
              <span>{playbackProgress.positionLabel}</span>
              <div className="playback-progress" role="meter" aria-label="Playback progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(playbackProgress.percent)}>
                <span style={{ width: `${playbackProgress.percent}%` }} />
              </div>
              <span>{playbackProgress.durationLabel}</span>
            </div>
          </div>
          <div className="transport-bar">
            <button className="icon-button large" type="button" title="Previous" aria-label="Previous" disabled={!selectedGroup} onClick={() => void runTransport("previous")}>
              <SkipBack size={22} />
            </button>
            <button className="icon-button large primary" type="button" title="Play" aria-label="Play" disabled={!selectedGroup} onClick={() => void runTransport("play")}>
              <Play size={24} />
            </button>
            <button className="icon-button large" type="button" title="Pause" aria-label="Pause" disabled={!selectedGroup} onClick={() => void runTransport("pause")}>
              <Pause size={22} />
            </button>
            <button className="icon-button large" type="button" title="Stop" aria-label="Stop" disabled={!selectedGroup} onClick={() => void runTransport("stop")}>
              <Square size={20} />
            </button>
            <button className="icon-button large" type="button" title="Next" aria-label="Next" disabled={!selectedGroup} onClick={() => void runTransport("next")}>
              <SkipForward size={22} />
            </button>
          </div>
          <div className="playback-volume">
            <VolumeControl
              label={primaryVolumeLabel}
              value={primaryVolume?.volume ?? 0}
              muted={primaryVolume?.muted ?? false}
              disabled={!primaryVolume}
              onChange={setPrimaryVolume}
              onMute={togglePrimaryMute}
              onSliderPointerDown={() => {
                if ((selectedGroup?.zones.length ?? 0) > 1) setVolumePopoverOpen(true);
              }}
            />
            {selectedGroup && selectedGroup.zones.length > 1 && volumePopoverOpen ? (
              <div className="volume-popover" role="dialog" aria-label="Room volumes">
                <div className="volume-popover-heading">
                  <strong>Room Volume</strong>
                  <button type="button" aria-label="Close room volumes" onClick={() => setVolumePopoverOpen(false)}>Close</button>
                </div>
                {selectedGroup.zones.map((zone) => (
                  <div className="volume-popover-row" key={zone.id}>
                    <div>
                      <strong>{zone.name}</strong>
                      <small>{zone.ipAddress}</small>
                    </div>
                    <VolumeControl
                      label={zone.name}
                      value={zoneVolumes[zone.id]?.volume ?? 0}
                      muted={zoneVolumes[zone.id]?.muted ?? false}
                      disabled={!zoneVolumes[zone.id]}
                      onChange={(volume) => setZoneVolume(zone.id, volume)}
                      onMute={() => toggleZoneMute(zone.id)}
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </section>

        <section className="queue-panel" aria-label="Queue">
          <div className="section-heading">
            <h2>Queue</h2>
            <div className="heading-actions">
              <span>{queue.length}</span>
              <button className="icon-button compact" type="button" title="Refresh queue" aria-label="Refresh queue" disabled={!selectedGroup || queueState === "loading"} onClick={() => selectedGroup && void loadQueue(selectedGroup.id)}>
                <RefreshCw size={16} />
              </button>
            </div>
          </div>
          {queueState === "loading" ? (
            <div className="empty-panel">Loading queue...</div>
          ) : queueState === "error" ? (
            <div className="empty-panel error-panel">
              <span>{queueError}</span>
              <button type="button" onClick={() => selectedGroup && void loadQueue(selectedGroup.id)}>Retry</button>
            </div>
          ) : queue.length === 0 ? (
            <div className="empty-panel">No queue items for this group.</div>
          ) : (
            <ol className="queue-list">
              {queue.map((item, index) => (
                <li key={`${item.id}-${index}`}>
                  <button type="button" onClick={() => void playQueueItem(index + 1)}>
                    <span>{item.title}</span>
                    <small>{[item.artist, item.album].filter(Boolean).join(" - ")}</small>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      </section>
    </main>
  );
}

interface VolumeControlProps {
  label: string;
  value: number;
  muted: boolean;
  disabled?: boolean;
  onChange: (volume: number) => void;
  onMute: () => void;
  onSliderPointerDown?: () => void;
}

function VolumeControl({ label, value, muted, disabled = false, onChange, onMute, onSliderPointerDown }: VolumeControlProps) {
  return (
    <div className="volume-control">
      <button className={muted ? "icon-button muted" : "icon-button"} type="button" title={muted ? "Unmute" : "Mute"} aria-label={`${muted ? "Unmute" : "Mute"} ${label}`} disabled={disabled} onClick={() => void onMute()}>
        {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
      </button>
      <input
        aria-label={`${label} volume`}
        type="range"
        min="0"
        max="100"
        value={value}
        disabled={disabled}
        onPointerDown={onSliderPointerDown}
        onFocus={onSliderPointerDown}
        onChange={(event) => onChange(Number.parseInt(event.currentTarget.value, 10))}
      />
      <output>{value}</output>
    </div>
  );
}

function playbackProgressFromNowPlaying(nowPlaying: NowPlaying | null, tick: number) {
  const positionSeconds = parseSonosTime(nowPlaying?.position);
  const durationSeconds = parseSonosTime(nowPlaying?.duration);
  const updatedAt = nowPlaying?.updatedAt ? Date.parse(nowPlaying.updatedAt) : Number.NaN;
  const elapsedSinceUpdate = nowPlaying?.state === "PLAYING" && Number.isFinite(updatedAt)
    ? Math.max(0, Math.floor((tick - updatedAt) / 1000))
    : 0;
  const livePosition = durationSeconds
    ? Math.min(durationSeconds, positionSeconds + elapsedSinceUpdate)
    : positionSeconds + elapsedSinceUpdate;
  const percent = durationSeconds > 0 ? Math.max(0, Math.min(100, (livePosition / durationSeconds) * 100)) : 0;

  return {
    percent,
    positionLabel: formatDuration(livePosition),
    durationLabel: durationSeconds > 0 ? formatDuration(durationSeconds) : "0:00"
  };
}

function parseSonosTime(value: string | undefined): number {
  if (!value || value === "NOT_IMPLEMENTED") return 0;
  const parts = value.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
}

function formatDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function groupsTopologyKey(groups: SonosGroup[]): string {
  return groups.map(groupTopologyKey).join("|");
}

function groupTopologyKey(group: SonosGroup): string {
  const zones = group.zones
    .map((zone) => `${zone.id}:${zone.uuid}:${zone.name}:${zone.ipAddress}:${zone.groupId ?? ""}:${zone.coordinatorId ?? ""}`)
    .sort()
    .join(",");
  return `${group.id}:${group.coordinatorId}:${group.coordinatorName}:${zones}`;
}

function applyPendingGroupEdits(groups: SonosGroup[], pendingEdits: PendingGroupEdit[]): SonosGroup[] {
  let nextGroups = cloneGroups(groups);
  for (const edit of pendingEdits) {
    const zone = removeZone(nextGroups, edit.zoneId);
    if (!zone) continue;
    if (edit.type === "join") {
      const target = nextGroups.find((group) => group.id === edit.groupId);
      if (target) {
        target.zones.push({
          ...zone,
          groupId: target.id,
          coordinatorId: target.coordinatorId
        });
      }
    } else {
      const groupId = optimisticGroupId(edit.id, zone.id);
      nextGroups.push({
        id: groupId,
        coordinatorId: zone.uuid,
        coordinatorName: zone.name,
        zones: [{
          ...zone,
          groupId,
          coordinatorId: zone.uuid
        }]
      });
    }
    nextGroups = normalizeDisplayGroups(nextGroups);
  }
  return nextGroups;
}

function cloneGroups(groups: SonosGroup[]): SonosGroup[] {
  return groups.map((group) => ({
    ...group,
    zones: group.zones.map((zone) => ({ ...zone }))
  }));
}

function removeZone(groups: SonosGroup[], zoneId: string) {
  for (const group of groups) {
    const index = group.zones.findIndex((zone) => zone.id === zoneId);
    if (index !== -1) {
      return group.zones.splice(index, 1)[0];
    }
  }
  return undefined;
}

function normalizeDisplayGroups(groups: SonosGroup[]): SonosGroup[] {
  return groups
    .filter((group) => group.zones.length > 0)
    .map((group) => {
      if (group.zones.some((zone) => zone.uuid === group.coordinatorId)) return group;
      const coordinator = group.zones[0];
      return {
        ...group,
        coordinatorId: coordinator.uuid,
        coordinatorName: coordinator.name,
        zones: group.zones.map((zone) => ({
          ...zone,
          coordinatorId: coordinator.uuid
        }))
      };
    });
}

function optimisticGroupId(editId: string, zoneId: string): string {
  return `pending:${editId}:${zoneId}`;
}

function isOptimisticGroupId(groupId: string): boolean {
  return groupId.startsWith("pending:");
}
