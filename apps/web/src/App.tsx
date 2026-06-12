import { ArrowLeft, AudioLines, ChevronDown, ListEnd, ListPlus, Pause, Play, RefreshCw, Settings, SkipBack, SkipForward, Square, Volume2, VolumeX } from "lucide-react";
import { IconCategoryPlus, IconMusic } from "@tabler/icons-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BridgeSnapshot, NowPlaying, QueueItem, SonosGroup, SonosZone, TransportAction, VolumeState } from "@misonos/sonos-protocol";
import { bridgeApi, subscribeBridgeEvents } from "./api.js";
import { paletteForMembers } from "./groupPalette.js";

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
  const [view, setView] = useState<"main" | "settings" | "browse" | "editor">("main");
  const [statusOpen, setStatusOpen] = useState(false);
  const [message, setMessage] = useState("Ready");
  const groupEditQueueRef = useRef<PendingGroupEdit[]>([]);
  const groupEditProcessingRef = useRef(false);

  const displayGroups = useMemo(() => {
    const next = applyPendingGroupEdits(groups, pendingGroupEdits);
    return [...next].sort((a, b) => membershipKey(a).localeCompare(membershipKey(b)));
  }, [groups, pendingGroupEdits]);

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) ?? groups[0],
    [groups, selectedGroupId]
  );

  const selectedVisibleZones = useMemo(
    () => selectedGroup?.zones.filter((zone) => zone.visible) ?? [],
    [selectedGroup]
  );

  const selectedPrimaryZone = useMemo(
    () => selectedVisibleZones.find((zone) => zone.uuid === selectedGroup?.coordinatorId) ?? selectedVisibleZones[0],
    [selectedGroup, selectedVisibleZones]
  );

  const primaryVolume = useMemo(() => {
    if (!selectedGroup) return null;
    if (selectedVisibleZones.length > 1 && groupVolume) return groupVolume;
    return selectedPrimaryZone ? zoneVolumes[selectedPrimaryZone.id] ?? null : null;
  }, [groupVolume, selectedGroup, selectedPrimaryZone, selectedVisibleZones, zoneVolumes]);

  const primaryVolumeLabel = selectedGroup && selectedVisibleZones.length > 1
    ? `${paletteForMembers(selectedVisibleZones.map((zone) => zone.uuid)).name} group`
    : selectedPrimaryZone?.name ?? "Selected room";

  const playbackProgress = useMemo(
    () => playbackProgressFromNowPlaying(nowPlaying, playbackTick),
    [nowPlaying, playbackTick]
  );

  const activeQueueIndex = useMemo(() => {
    if (!nowPlaying) return -1;
    const playlistPosition = nowPlaying.playlistPosition;
    if (typeof playlistPosition === "number" && playlistPosition >= 1 && playlistPosition <= queue.length) {
      return playlistPosition - 1;
    }
    if (nowPlaying.uri) {
      const byUri = queue.findIndex((item) => item.uri === nowPlaying.uri);
      if (byUri !== -1) return byUri;
    }
    return queue.findIndex(
      (item) =>
        item.title === nowPlaying.title &&
        (item.artist ?? "") === (nowPlaying.artist ?? "") &&
        (item.album ?? "") === (nowPlaying.album ?? "")
    );
  }, [nowPlaying, queue]);

  const applySnapshot = useCallback((snapshot: BridgeSnapshot) => {
    setGroups((current) => (groupsTopologyKey(current) === groupsTopologyKey(snapshot.groups) ? current : snapshot.groups));
    setSelectedGroupId((current) => {
      if (current && snapshot.groups.some((group) => group.id === current)) return current;
      const stored = readStoredGroupKey();
      if (stored) {
        const match = snapshot.groups.find((group) => membershipKey(group) === stored);
        if (match) return match.id;
      }
      return snapshot.groups[0]?.id || "";
    });
  }, []);

  useEffect(() => {
    if (!selectedGroupId) return;
    const group = groups.find((entry) => entry.id === selectedGroupId);
    if (!group) return;
    try { window.localStorage.setItem(SELECTED_GROUP_STORAGE_KEY, membershipKey(group)); } catch { /* ignore */ }
  }, [selectedGroupId, groups]);

  const loadNowPlaying = useCallback(async (groupId: string) => {
    setNowPlaying(await bridgeApi.nowPlaying(groupId));
  }, []);

  const loadQueue = useCallback(async (groupId: string, background = false) => {
    if (!background) {
      setQueueState("loading");
      setQueueError("");
    }
    try {
      const next = await bridgeApi.queue(groupId);
      setQueue(next);
      setQueueState("ready");
    } catch (error) {
      if (background) return;
      setQueueState("error");
      setQueueError(error instanceof Error ? error.message : "Could not load queue");
    }
  }, []);

  const loadVolumes = useCallback(async (group: SonosGroup) => {
    const visibleZones = group.zones.filter((zone) => zone.visible);
    const [nextGroupVolume, nextZoneVolumes] = await Promise.all([
      visibleZones.length > 1 ? bridgeApi.groupVolume(group.id).catch(() => null) : Promise.resolve(null),
      Promise.all(visibleZones.map((zone) => bridgeApi.zoneVolume(zone.id).catch(() => null)))
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
      void loadQueue(groupId, true);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [loadNowPlaying, loadQueue, loadVolumes, selectedGroup]);

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

  const runSeek = async (positionSeconds: number) => {
    if (!selectedGroup) return;
    setNowPlaying(await bridgeApi.seek(selectedGroup.id, positionSeconds));
    void loadNowPlaying(selectedGroup.id);
  };

  const setZoneVolume = async (zoneId: string, volume: number) => {
    const previous = zoneVolumes[zoneId]?.volume;
    if (!confirmVolumeJump(previous, volume)) return;
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
    if (!confirmVolumeJump(groupVolume?.volume, volume)) return;
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
    if (selectedVisibleZones.length > 1) {
      await setSelectedGroupVolume(volume);
    } else if (selectedPrimaryZone) {
      await setZoneVolume(selectedPrimaryZone.id, volume);
    }
  };

  const togglePrimaryMute = async () => {
    if (!selectedGroup) return;
    if (selectedVisibleZones.length > 1) {
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
    enqueueGroupEdit({ id: randomEditId(), type: "standalone", zoneId });
  };

  const promoteZone = async (zoneId: string) => {
    try {
      setGroupEditBusy(true);
      const snapshot = await bridgeApi.promoteZoneToCoordinator(zoneId);
      applySnapshot(snapshot);
    } catch {
      // swallow; next snapshot event will reconcile state
    } finally {
      setGroupEditBusy(false);
    }
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
    enqueueGroupEdit({ id: randomEditId(), type: "join", zoneId, groupId });
  };

  const groupOptions = displayGroups.map((group) => {
    const visible = group.zones.filter((zone) => zone.visible);
    const { color, name } = paletteForMembers(visible.map((zone) => zone.uuid));
    const zoneList = visible.map((zone) => zone.name).join(" + ");
    return { id: group.id, key: membershipKey(group), color, name, zoneList };
  });
  const selectedGroupOption = groupOptions.find((option) => option.id === selectedGroup?.id) ?? groupOptions[0];

  return (
    <main className="app-shell">
      <header className={`topbar ${view === "main" ? "compact main" : "compact"}`}>
        {view === "main" ? (
          <>
            <GroupDropdown
              options={groupOptions}
              selectedId={selectedGroup?.id}
              selectedOption={selectedGroupOption}
              onSelect={setSelectedGroupId}
              onEditGroups={() => setView("editor")}
            />
            <div className="topbar-actions">
              <button className="icon-button" type="button" title="Browse music sources" aria-label="Browse music sources" onClick={() => setView("browse")}>
                <IconMusic size={18} />
              </button>
              <button className="icon-button" type="button" title="Settings" aria-label="Settings" onClick={() => setView("settings")}>
                <Settings size={18} />
              </button>
            </div>
          </>
        ) : (
          <>
            <button className="icon-button topbar-back" type="button" title="Back" aria-label="Back" onClick={() => setView("main")}>
              <ArrowLeft size={18} />
            </button>
            <span className="topbar-title">{view === "settings" ? "Settings" : view === "browse" ? "Browse" : "Group Editor"}</span>
            {view === "settings" ? (
              <>
                <p className="eyebrow">MiSonos</p>
                <div className="topbar-status" onMouseLeave={() => setStatusOpen(false)}>
                  <button
                    type="button"
                    className="status-dot-btn"
                    aria-label={`Connection status: ${message}`}
                    title={message}
                    onClick={() => setStatusOpen((current) => !current)}
                  >
                    <span className={`status-dot ${state}`} aria-hidden="true" />
                  </button>
                  {statusOpen ? (
                    <div className="status-popover" role="status">
                      <strong>{message}</strong>
                      <small>State: {state}</small>
                      <button type="button" onClick={() => { void loadSnapshot(true); setStatusOpen(false); }}>Rediscover speakers</button>
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
          </>
        )}
      </header>

      <section
        className="settings-page browse-page"
        aria-label="Browse"
        hidden={view !== "browse"}
        style={view === "browse" ? undefined : { display: "none" }}
      >
        <SourceBrowser
          groups={displayGroups}
          selectedGroupId={selectedGroup?.id}
          onSelectGroup={setSelectedGroupId}
        />
      </section>

      {view === "settings" ? (
        <section className="settings-page" aria-label="Settings">
          <AboutSystem />
          <CustomMusicServices zones={displayGroups.flatMap((group) => group.zones).filter((zone) => zone.visible)} />
          <MusicServicesDebug />
          <BrowseDebug />
        </section>
      ) : view === "editor" ? (
        <section className="editor-page" aria-label="Group editor">
          <Suspense fallback={<div className="empty-panel">Loading group editor...</div>}>
            <GroupEditor
              groups={displayGroups}
              selectedGroupId={selectedGroup?.id}
              busy={groupEditBusy}
              onSelectGroup={setSelectedGroupId}
              onJoinZoneGroup={(zoneId, groupId) => void joinZoneToGroup(zoneId, groupId)}
              onUngroupZone={(zoneId) => void makeZoneStandalone(zoneId)}
              onPromoteZone={(zoneId) => void promoteZone(zoneId)}
              onClose={() => setView("main")}
            />
          </Suspense>
        </section>
      ) : (
      <section className="controller-grid main-view">
        <section className="now-playing" aria-label="Now playing">
          <div className="artwork-frame">
            {nowPlaying?.albumArtUri ? <img src={nowPlaying.albumArtUri} alt="" /> : <div className="artwork-fallback">Mi</div>}
          </div>
          <div className="track-copy">
            <p className="eyebrow">{nowPlaying?.state ?? "UNKNOWN"}</p>
            <h2>{nowPlaying?.title ?? "Nothing selected"}</h2>
            <p>{[nowPlaying?.artist, nowPlaying?.album].filter(Boolean).join(" - ")}</p>
            <div className="progress-copy">
              <span>{playbackProgress.positionLabel}</span>
              <button
                type="button"
                className="playback-progress"
                role="meter"
                aria-label="Playback progress (click to seek)"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(playbackProgress.percent)}
                disabled={!selectedGroup || !playbackProgress.durationSeconds}
                onClick={(event) => {
                  if (!playbackProgress.durationSeconds) return;
                  const target = event.currentTarget.getBoundingClientRect();
                  const ratio = Math.max(0, Math.min(1, (event.clientX - target.left) / target.width));
                  void runSeek(Math.round(ratio * playbackProgress.durationSeconds));
                }}
              >
                <span style={{ width: `${playbackProgress.percent}%` }} />
              </button>
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
              swallowFirstAdjustment={selectedVisibleZones.length > 1 && !volumePopoverOpen}
              onSliderPointerDown={() => {
                if (selectedVisibleZones.length > 1) setVolumePopoverOpen(true);
              }}
            />
            {selectedGroup && selectedVisibleZones.length > 1 && volumePopoverOpen ? (
              <div className="volume-popover" role="dialog" aria-label="Room volumes">
                <div className="volume-popover-heading">
                  <strong>Room Volume</strong>
                  <button type="button" aria-label="Close room volumes" onClick={() => setVolumePopoverOpen(false)}>Close</button>
                </div>
                {selectedVisibleZones.map((zone) => (
                  <div className="volume-popover-row" key={zone.id}>
                    <div>
                      <strong>{zone.name}</strong>
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
            <QueueList
              queue={queue}
              activeIndex={activeQueueIndex}
              isPlaying={nowPlaying?.state === "PLAYING"}
              onPlay={(index) => void playQueueItem(index + 1)}
            />
          )}
        </section>
      </section>
      )}
    </main>
  );
}

interface GroupOption {
  id: string;
  key: string;
  color: string;
  name: string;
  zoneList: string;
}

interface GroupDropdownProps {
  options: GroupOption[];
  selectedId?: string;
  selectedOption?: GroupOption;
  onSelect: (groupId: string) => void;
  onEditGroups?: () => void;
}

function GroupDropdown({ options, selectedId, selectedOption, onSelect, onEditGroups }: GroupDropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (options.length === 0) {
    return <div className="topbar-group-empty">No groups</div>;
  }

  return (
    <div className="topbar-group" ref={containerRef}>
      <button
        type="button"
        className="topbar-group-trigger"
        style={selectedOption ? { background: hexToRgba(selectedOption.color, 0.18), borderColor: hexToRgba(selectedOption.color, 0.55) } : undefined}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selectedOption ? (
          <>
            <span className="group-color-chip" style={{ background: selectedOption.color }} aria-hidden="true" />
            <span className="topbar-group-label">
              <strong>{selectedOption.name}</strong>
              {selectedOption.zoneList ? <small>{selectedOption.zoneList}</small> : null}
            </span>
          </>
        ) : (
          <span className="topbar-group-label"><strong>Select group</strong></span>
        )}
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open ? (
        <ul className="topbar-group-menu" role="listbox">
          {options.map((option) => (
            <li key={option.key}>
              <button
                type="button"
                role="option"
                aria-selected={option.id === selectedId}
                className={option.id === selectedId ? "selected" : undefined}
                style={{ background: hexToRgba(option.color, 0.18), borderColor: hexToRgba(option.color, 0.55) }}
                onClick={() => { onSelect(option.id); setOpen(false); }}
              >
                <span className="group-color-chip" style={{ background: option.color }} aria-hidden="true" />
                <span className="topbar-group-label">
                  <strong>{option.name}</strong>
                  {option.zoneList ? <small>{option.zoneList}</small> : null}
                </span>
              </button>
            </li>
          ))}
          {onEditGroups ? (
            <>
              <li className="topbar-group-menu-separator" aria-hidden="true" />
              <li>
                <button
                  type="button"
                  className="topbar-group-menu-action"
                  onClick={() => { onEditGroups(); setOpen(false); }}
                >
                  <IconCategoryPlus size={16} aria-hidden="true" />
                  <span className="topbar-group-label"><strong>Edit Groups</strong></span>
                </button>
              </li>
            </>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const bigint = parseInt(value, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface SourceBrowserProps {
  groups: SonosGroup[];
  selectedGroupId?: string;
  onSelectGroup: (groupId: string) => void;
}

interface BrowseCrumb {
  id: string;
  title: string;
}

const SOURCE_STORAGE_KEY = "misonos:lastSourceId";

function SourceBrowser({ groups, selectedGroupId, onSelectGroup }: SourceBrowserProps) {
  const [sources, setSources] = useState<Awaited<ReturnType<typeof bridgeApi.listSources>> | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try { return window.localStorage.getItem(SOURCE_STORAGE_KEY); } catch { return null; }
  });

  const persistSourceId = useCallback((id: string) => {
    setSourceId(id);
    try { window.localStorage.setItem(SOURCE_STORAGE_KEY, id); } catch { /* ignore */ }
  }, []);
  const [stack, setStack] = useState<BrowseCrumb[]>([]);
  const [data, setData] = useState<Awaited<ReturnType<typeof bridgeApi.browseSource>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => {
    if (!status) return undefined;
    const timeout = window.setTimeout(() => setStatus(null), status.ok ? 3500 : 6000);
    return () => window.clearTimeout(timeout);
  }, [status]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchActive, setSearchActive] = useState(false);

  const activeSource = sources?.find((entry) => entry.id === sourceId);
  const supportsSearch = activeSource?.capabilities?.includes("search") ?? false;

  const browseGroupOptions = useMemo(
    () => groups.map((group) => {
      const visible = group.zones.filter((zone) => zone.visible);
      const { color, name } = paletteForMembers(visible.map((zone) => zone.uuid));
      return {
        id: group.id,
        key: membershipKey(group),
        color,
        name,
        zoneList: visible.map((zone) => zone.name).join(" + ")
      };
    }),
    [groups]
  );

  const runSearch = useCallback(async () => {
    if (!sourceId || !searchQuery.trim()) return;
    setLoading(true);
    setError("");
    setSearchActive(true);
    try {
      const next = await bridgeApi.searchSource(sourceId, searchQuery.trim());
      setData(next);
      setStack([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }, [sourceId, searchQuery]);

  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setSearchActive(false);
    setData(null);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const next = await bridgeApi.listSources();
        setSources(next);
        if (next.length > 0) {
          const stillExists = sourceId ? next.some((entry) => entry.id === sourceId) : false;
          if (!stillExists) persistSourceId(next[0].id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load sources");
      }
    })();
  }, [sourceId, persistSourceId]);

  useEffect(() => {
    if (!sourceId || searchActive) return;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const id = stack.length > 0 ? stack[stack.length - 1].id : undefined;
        const next = await bridgeApi.browseSource(sourceId, id);
        setData(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to browse");
      } finally {
        setLoading(false);
      }
    })();
  }, [sourceId, stack, searchActive]);

  const drill = useCallback((item: { id: string; title: string }) => {
    setStack((current) => [...current, { id: item.id, title: item.title }]);
  }, []);

  const pop = useCallback((targetIndex: number) => {
    setStack((current) => current.slice(0, targetIndex));
  }, []);

  const enqueueAll = useCallback(async (mode: "replace" | "next" | "end") => {
    if (!sourceId || !selectedGroupId) {
      setStatus({ ok: false, message: "Pick a group first." });
      return;
    }
    const allTrackIds = (data?.items ?? [])
      .filter((entry) => entry.kind === "playable")
      .map((entry) => entry.id)
      .slice(0, 100);
    if (allTrackIds.length === 0) {
      setStatus({ ok: false, message: "No playable tracks in this view." });
      return;
    }
    setPlaying(`all:${mode}`);
    setStatus(null);
    try {
      await bridgeApi.playSourceItems(sourceId, { trackIds: allTrackIds, groupId: selectedGroupId, mode });
      const verb = mode === "replace" ? "Playing" : mode === "next" ? "Queued next:" : "Queued at end:";
      setStatus({ ok: true, message: `${verb} ${allTrackIds.length} tracks.` });
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Action failed" });
    } finally {
      setPlaying(null);
    }
  }, [sourceId, selectedGroupId, data]);

  const enqueueItem = useCallback(async (item: { id: string; title: string; kind: "container" | "album" | "playable" }, mode: "replace" | "next" | "end") => {
    if (!sourceId || !selectedGroupId) {
      setStatus({ ok: false, message: "Pick a group first." });
      return;
    }
    setPlaying(`${item.id}:${mode}`);
    setStatus(null);
    try {
      let trackIds: string[];
      if (item.kind === "playable") {
        trackIds = [item.id];
      } else {
        const expansion = await bridgeApi.browseSource(sourceId, item.id);
        trackIds = expansion.items.filter((entry) => entry.kind === "playable").map((entry) => entry.id);
        if (trackIds.length === 0) {
          setStatus({ ok: false, message: `“${item.title}” has no playable tracks.` });
          return;
        }
      }
      await bridgeApi.playSourceItems(sourceId, { trackIds, groupId: selectedGroupId, mode });
      const label = trackIds.length === 1 ? `“${item.title}”` : `${trackIds.length} tracks from “${item.title}”`;
      const verb = mode === "replace" ? "Playing" : mode === "next" ? "Queued next:" : "Queued at end:";
      setStatus({ ok: true, message: `${verb} ${label}.` });
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Action failed" });
    } finally {
      setPlaying(null);
    }
  }, [sourceId, selectedGroupId]);

  if (sources && sources.length === 0) {
    return (
      <section className="queue-panel">
        <div className="empty-panel">No browse sources are running. Start a source service (e.g. <code>npm run dev:grateful</code>).</div>
      </section>
    );
  }

  return (
    <section className="queue-panel" aria-label="Source browser">

      <div className="browse-controls">
        <label>
          <span>Source</span>
          <select
            value={sourceId ?? ""}
            onChange={(event) => { persistSourceId(event.target.value); setStack([]); clearSearch(); }}
          >
            {(sources ?? []).map((source) => (
              <option key={source.id} value={source.id}>{source.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Play to group</span>
          <GroupDropdown
            options={browseGroupOptions}
            selectedId={selectedGroupId}
            selectedOption={browseGroupOptions.find((option) => option.id === selectedGroupId) ?? browseGroupOptions[0]}
            onSelect={onSelectGroup}
          />
        </label>
        {supportsSearch ? (
          <label className="browse-search-label">
            <span>Search</span>
            <form
              onSubmit={(event) => { event.preventDefault(); void runSearch(); }}
              style={{ display: "flex", gap: 6 }}
            >
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={`Search ${activeSource?.name ?? ""}`}
              />
              {searchActive ? (
                <button type="button" onClick={clearSearch} className="browse-search-clear">Clear</button>
              ) : null}
            </form>
          </label>
        ) : null}
      </div>

      {(() => {
        const playableCount = (data?.items ?? []).filter((entry) => entry.kind === "playable").length;
        if (playableCount < 2) return null;
        const enqueueLimit = Math.min(playableCount, 100);
        return (
          <div className="browse-bulk">
            <span>{playableCount > 100 ? `Bulk actions act on first 100 of ${playableCount}` : `${playableCount} tracks`}</span>
            <div className="browse-bulk-actions">
              <button type="button" disabled={playing !== null || !selectedGroupId} onClick={() => void enqueueAll("replace")}>
                <Play size={14} /> Play all ({enqueueLimit})
              </button>
              <button type="button" disabled={playing !== null || !selectedGroupId} onClick={() => void enqueueAll("next")}>
                <ListPlus size={14} /> Play next
              </button>
              <button type="button" disabled={playing !== null || !selectedGroupId} onClick={() => void enqueueAll("end")}>
                <ListEnd size={14} /> Add to end
              </button>
            </div>
          </div>
        );
      })()}

      <nav className="browse-crumbs" aria-label="Path">
        <button type="button" onClick={() => pop(0)}>Root</button>
        {stack.map((crumb, index) => (
          <span key={`${crumb.id}-${index}`}>
            <span className="browse-crumb-sep">/</span>
            <button type="button" onClick={() => pop(index + 1)}>{crumb.title}</button>
          </span>
        ))}
      </nav>

      {error ? (
        <div className="empty-panel error-panel"><span>{error}</span></div>
      ) : loading && !data ? (
        <div className="empty-panel">Loading…</div>
      ) : data ? (
        data.items.length === 0 ? (
          <div className="empty-panel">No items.</div>
        ) : (
          <ol className="browse-list">
            {data.items.map((item) => {
              if (item.kind === "container") {
                return (
                  <li key={item.id}>
                    <button type="button" className="browse-drill" onClick={() => drill(item)}>
                      <span>{item.title}</span>
                      {item.subtitle ? <small>{item.subtitle}</small> : null}
                    </button>
                  </li>
                );
              }
              const subtitle = item.kind === "album"
                ? item.subtitle
                : [item.artist, item.album].filter(Boolean).join(" · ") + (item.durationSeconds ? ` · ${formatDuration(item.durationSeconds)}` : "");
              const isAlbum = item.kind === "album";
              return (
                <li key={item.id}>
                  <div className="browse-track">
                    {isAlbum ? (
                      <button type="button" className="browse-drill-inline" onClick={() => drill(item)}>
                        <span>{item.title}</span>
                        {subtitle ? <small>{subtitle}</small> : null}
                      </button>
                    ) : (
                      <div className="browse-track-meta">
                        <span>{item.title}</span>
                        {subtitle ? <small>{subtitle}</small> : null}
                      </div>
                    )}
                    <div className="browse-actions">
                      <button
                        type="button"
                        className="browse-action"
                        title={isAlbum ? "Play this concert (replace queue)" : "Play now (replace queue)"}
                        aria-label="Play now"
                        disabled={playing !== null || !selectedGroupId}
                        onClick={() => void enqueueItem(item, "replace")}
                      >
                        {playing === `${item.id}:replace` ? "…" : <Play size={14} />}
                      </button>
                      <button
                        type="button"
                        className="browse-action"
                        title="Play next"
                        aria-label="Play next"
                        disabled={playing !== null || !selectedGroupId}
                        onClick={() => void enqueueItem(item, "next")}
                      >
                        {playing === `${item.id}:next` ? "…" : <ListPlus size={14} />}
                      </button>
                      <button
                        type="button"
                        className="browse-action"
                        title="Add to end of queue"
                        aria-label="Add to end"
                        disabled={playing !== null || !selectedGroupId}
                        onClick={() => void enqueueItem(item, "end")}
                      >
                        {playing === `${item.id}:end` ? "…" : <ListEnd size={14} />}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )
      ) : null}

      {status ? (
        <div className={status.ok ? "service-result ok" : "service-result error"}>{status.message}</div>
      ) : null}
    </section>
  );
}

interface CustomMusicServicesProps {
  zones: SonosZone[];
}

function CustomMusicServices({ zones }: CustomMusicServicesProps) {
  const [presets, setPresets] = useState<Awaited<ReturnType<typeof bridgeApi.customServicePresets>> | null>(null);
  const [discovered, setDiscovered] = useState<Awaited<ReturnType<typeof bridgeApi.musicServices>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [zoneByPreset, setZoneByPreset] = useState<Record<string, string>>({});
  const [hostByPreset, setHostByPreset] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextPresets, nextDiscovered] = await Promise.all([
        bridgeApi.customServicePresets(),
        bridgeApi.musicServices().catch(() => null)
      ]);
      setPresets(nextPresets);
      setDiscovered(nextDiscovered);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const registeredNames = useMemo(() => new Set(discovered?.services.map((service) => service.name.toLowerCase()) ?? []), [discovered]);

  const register = useCallback(async (presetId: string) => {
    if (!presets) return;
    const preset = presets.find((entry) => entry.id === presetId);
    if (!preset) return;
    const zoneId = zoneByPreset[presetId] ?? zones[0]?.id;
    if (!zoneId) {
      setResults((current) => ({ ...current, [presetId]: { ok: false, message: "No reachable speakers" } }));
      return;
    }
    setBusy(presetId);
    setResults((current) => {
      const { [presetId]: _omit, ...rest } = current;
      void _omit;
      return rest;
    });
    try {
      const hostOverride = hostByPreset[presetId]?.trim();
      const result = await bridgeApi.registerCustomService({
        presetId,
        zoneId,
        hostOverride: hostOverride || undefined
      });
      const ok = result.status === 200;
      const trimmedBody = result.body.length > 600 ? `${result.body.slice(0, 600)}…` : result.body;
      setResults((current) => ({
        ...current,
        [presetId]: {
          ok,
          message: ok
            ? `Registered as ${preset.name} via ${result.attemptedUri}. Open the Sonos app and add it from “Add a Service.”`
            : `Speaker returned HTTP ${result.status}. URI tried: ${result.attemptedUri}.\n${trimmedBody}`
        }
      }));
      await load();
    } catch (err) {
      setResults((current) => ({ ...current, [presetId]: { ok: false, message: err instanceof Error ? err.message : "Failed" } }));
    } finally {
      setBusy(null);
    }
  }, [presets, zoneByPreset, hostByPreset, zones, load]);

  return (
    <section className="queue-panel" aria-label="Custom music services">
      <div className="section-heading">
        <h2>Custom Music Services</h2>
        <div className="heading-actions">
          <button className="icon-button compact" type="button" onClick={() => void load()} title="Refresh">
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      {loading && !presets ? (
        <div className="empty-panel">Loading...</div>
      ) : error ? (
        <div className="empty-panel error-panel"><span>{error}</span></div>
      ) : presets && presets.length > 0 ? (
        <div className="custom-services">
          {presets.map((preset) => {
            const isRegistered = registeredNames.has(preset.name.toLowerCase());
            const result = results[preset.id];
            const chosenZone = zoneByPreset[preset.id] ?? zones[0]?.id ?? "";
            const hostOverride = hostByPreset[preset.id] ?? "";
            const effectiveUri = hostOverride
              ? `http://${hostOverride}:${preset.port}${preset.path ?? "/"}`
              : preset.uri ?? "(no LAN IP detected — set host override)";
            return (
              <article key={preset.id} className="custom-service-card">
                <header>
                  <div>
                    <h3>{preset.name}</h3>
                    <small>{preset.description}</small>
                  </div>
                  <span className={isRegistered ? "service-status registered" : "service-status pending"}>
                    {isRegistered ? "Registered" : "Not registered"}
                  </span>
                </header>
                <dl>
                  <dt>Endpoint</dt>
                  <dd><code style={{ wordBreak: "break-all" }}>{effectiveUri}</code></dd>
                  <dt>Auth</dt>
                  <dd>{preset.authType}</dd>
                  <dt>Poll</dt>
                  <dd>{preset.pollInterval}s</dd>
                </dl>
                <div className="custom-service-controls">
                  <label>
                    <span>Register on speaker</span>
                    <select value={chosenZone} onChange={(event) => setZoneByPreset((current) => ({ ...current, [preset.id]: event.target.value }))}>
                      {zones.map((zone) => (
                        <option key={zone.id} value={zone.id}>{zone.name} ({zone.ipAddress})</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Host override (optional)</span>
                    <input
                      value={hostOverride}
                      onChange={(event) => setHostByPreset((current) => ({ ...current, [preset.id]: event.target.value }))}
                      placeholder={preset.detectedHostIp ?? "192.168.x.x"}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void register(preset.id)}
                    disabled={busy !== null || zones.length === 0}
                  >
                    {busy === preset.id ? "Registering..." : isRegistered ? "Re-register" : "Register"}
                  </button>
                </div>
                {result ? (
                  <div className={result.ok ? "service-result ok" : "service-result error"}>{result.message}</div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty-panel">No presets defined.</div>
      )}
    </section>
  );
}

function AboutSystem() {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof bridgeApi.devices>> | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      setDevices(await bridgeApi.devices());
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setState("error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="queue-panel" aria-label="About my Sonos system">
      <div className="section-heading">
        <h2>About My Sonos System</h2>
        <div className="heading-actions">
          <button className="icon-button compact" type="button" onClick={() => void load()} title="Refresh">
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      {state === "loading" && !devices ? (
        <div className="empty-panel">Loading...</div>
      ) : state === "error" ? (
        <div className="empty-panel error-panel"><span>{error}</span></div>
      ) : devices && devices.length > 0 ? (
        <div className="about-system">
          {devices.map((device) => (
            <article key={device.uuid} className="about-system-card">
              <header>
                <h3>{device.zoneName}</h3>
                <span>{device.displayName ?? device.modelName ?? "Sonos"}</span>
              </header>
              <dl>
                <Row label="Model" value={device.modelName} />
                <Row label="Model #" value={device.modelNumber} />
                <Row label="Serial" value={device.serialNumber} mono />
                <Row label="Sonos OS" value={swGenLabel(device.swGen)} />
                <Row label="Software" value={device.softwareVersion} />
                <Row label="Hardware" value={device.hardwareVersion} />
                <Row label="DSP" value={device.dspVersion} />
                <Row label="IP" value={device.ipAddress} mono />
                <Row label="MAC" value={device.macAddress} mono />
                <Row label="Min compatible" value={device.minCompatibleVersion} />
                <Row label="Extra" value={device.extraInfo} />
              </dl>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-panel">No reachable speakers.</div>
      )}
    </section>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string | undefined; mono?: boolean }) {
  if (!value) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd style={mono ? { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.82rem" } : undefined}>{value}</dd>
    </>
  );
}

function swGenLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === "1") return "S1";
  if (value === "2") return "S2";
  return value;
}

function MusicServicesDebug() {
  const [servicesState, setServicesState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [services, setServices] = useState<Awaited<ReturnType<typeof bridgeApi.musicServices>> | null>(null);
  const [servicesError, setServicesError] = useState<string>("");

  const [accountsState, setAccountsState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [accounts, setAccounts] = useState<Awaited<ReturnType<typeof bridgeApi.sonosAccounts>> | null>(null);
  const [accountsError, setAccountsError] = useState<string>("");

  const loadServices = useCallback(async () => {
    setServicesState("loading");
    setServicesError("");
    try {
      setServices(await bridgeApi.musicServices());
      setServicesState("ready");
    } catch (err) {
      setServicesError(err instanceof Error ? err.message : "Failed");
      setServicesState("error");
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    setAccountsState("loading");
    setAccountsError("");
    try {
      setAccounts(await bridgeApi.sonosAccounts());
      setAccountsState("ready");
    } catch (err) {
      setAccountsError(err instanceof Error ? err.message : "Failed");
      setAccountsState("error");
    }
  }, []);

  const ytmServiceId = services?.youtubeMusic?.id ?? null;
  const matchingAccount = useMemo(() => {
    if (!accounts || ytmServiceId === null) return null;
    return accounts.accounts.find((account) => account.type - 2048 === ytmServiceId)
      ?? accounts.accounts.find((account) => account.type === ytmServiceId)
      ?? null;
  }, [accounts, ytmServiceId]);

  return (
    <section className="queue-panel" aria-label="Music services">
      <div className="section-heading">
        <h2>Music Services (debug)</h2>
        <div className="heading-actions">
          <button className="icon-button compact" type="button" onClick={() => void loadServices()} title="Discover services">
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      {servicesState === "idle" ? (
        <div className="empty-panel">Tap refresh to discover services.</div>
      ) : servicesState === "loading" ? (
        <div className="empty-panel">Discovering...</div>
      ) : servicesState === "error" ? (
        <div className="empty-panel error-panel"><span>{servicesError}</span></div>
      ) : services ? (
        <div className="music-services-debug">
          <p>
            <strong>YouTube Music:</strong>{" "}
            {services.youtubeMusic
              ? `id ${services.youtubeMusic.id} · auth ${services.youtubeMusic.authType ?? "?"}`
              : "not linked"}
          </p>
        </div>
      ) : null}

      <div className="section-heading" style={{ marginTop: 16 }}>
        <h2>Linked accounts</h2>
        <div className="heading-actions">
          <button className="icon-button compact" type="button" onClick={() => void loadAccounts()} title="Fetch accounts">
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      {accountsState === "idle" ? (
        <div className="empty-panel">Tap refresh to fetch /status/accounts.</div>
      ) : accountsState === "loading" ? (
        <div className="empty-panel">Fetching...</div>
      ) : accountsState === "error" ? (
        <div className="empty-panel error-panel"><span>{accountsError}</span></div>
      ) : accounts ? (
        <div className="music-services-debug">
          <p>
            <strong>YouTube Music account:</strong>{" "}
            {matchingAccount
              ? `type ${matchingAccount.type} · serial ${matchingAccount.serialNum ?? "?"} · key ${maskToken(matchingAccount.key)} · user ${matchingAccount.username ?? "—"}`
              : ytmServiceId !== null
                ? `not matched (looked for type=${ytmServiceId + 2048} or type=${ytmServiceId})`
                : "(load services first to match)"}
          </p>
          <details>
            <summary>All accounts ({accounts.accounts.length})</summary>
            <ul>
              {accounts.accounts.map((account, index) => (
                <li key={`${account.type}-${account.serialNum ?? index}`}>
                  <code>type {account.type}</code>{" "}
                  {account.serialNum ? `serial ${account.serialNum} · ` : ""}
                  {account.username ? `user ${account.username} · ` : ""}
                  key {maskToken(account.key)}
                </li>
              ))}
            </ul>
          </details>
          <details>
            <summary>Raw XML ({accounts.raw.length} bytes)</summary>
            <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.7rem" }}>{accounts.raw}</pre>
          </details>
        </div>
      ) : null}
    </section>
  );
}

type BrowseRecord = { request: { kind: "browse" | "search"; objectId: string; criteria?: string }; result: Awaited<ReturnType<typeof bridgeApi.musicBrowse>>; at: string } | { request: { kind: "browse" | "search"; objectId: string; criteria?: string }; error: string; at: string };

function BrowseDebug() {
  const [objectId, setObjectId] = useState("S:");
  const [criteria, setCriteria] = useState("");
  const [history, setHistory] = useState<BrowseRecord[]>([]);
  const [busy, setBusy] = useState(false);

  const presets = useMemo(() => ([
    { label: "Root", objectId: "S:" },
    { label: "YT Music root (S:284)", objectId: "S:284" },
    { label: "YT Music root (SQ:284)", objectId: "SQ:284" },
    { label: "Service 284 search", objectId: "SE:284" },
    { label: "Saved queue (Q:0)", objectId: "Q:0" }
  ]), []);

  const run = useCallback(async (kind: "browse" | "search") => {
    setBusy(true);
    const request = { kind, objectId, criteria: kind === "search" ? criteria : undefined };
    try {
      const result = kind === "browse"
        ? await bridgeApi.musicBrowse({ objectId, requestedCount: 50 })
        : await bridgeApi.musicSearch({ containerId: objectId, searchCriteria: criteria, requestedCount: 50 });
      setHistory((current) => [{ request, result, at: new Date().toISOString() }, ...current].slice(0, 20));
    } catch (err) {
      setHistory((current) => [{ request, error: err instanceof Error ? err.message : "Failed", at: new Date().toISOString() }, ...current].slice(0, 20));
    } finally {
      setBusy(false);
    }
  }, [objectId, criteria]);

  return (
    <section className="queue-panel" aria-label="ContentDirectory browse/search">
      <div className="section-heading">
        <h2>ContentDirectory Browse / Search</h2>
      </div>
      <div style={{ display: "grid", gap: 8, padding: "0 0 12px" }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: "0.78rem", color: "#aeb4ad" }}>ObjectID / ContainerID</span>
          <input value={objectId} onChange={(event) => setObjectId(event.target.value)} style={inputStyle} />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: "0.78rem", color: "#aeb4ad" }}>SearchCriteria (only used for Search)</span>
          <input value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="e.g. dc:title contains &quot;phish&quot;" style={inputStyle} />
        </label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" disabled={busy || !objectId} onClick={() => void run("browse")} style={buttonStyle}>Browse</button>
          <button type="button" disabled={busy || !objectId || !criteria} onClick={() => void run("search")} style={buttonStyle}>Search</button>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {presets.map((preset) => (
            <button key={preset.label} type="button" onClick={() => setObjectId(preset.objectId)} style={presetButtonStyle}>{preset.label}</button>
          ))}
        </div>
      </div>
      {history.length === 0 ? (
        <div className="empty-panel">No requests yet. Try Browse with the presets above.</div>
      ) : (
        <ol className="browse-history" style={{ display: "grid", gap: 12, listStyle: "none", padding: 0 }}>
          {history.map((record, index) => (
            <li key={`${record.at}-${index}`} style={{ border: "1px solid rgba(242,240,232,0.1)", borderRadius: 8, padding: 10 }}>
              <div style={{ fontSize: "0.78rem", color: "#aeb4ad" }}>
                {record.request.kind === "browse" ? "Browse" : "Search"} · <code>{record.request.objectId}</code>
                {record.request.criteria ? <> · criteria: <code>{record.request.criteria}</code></> : null}
              </div>
              {"error" in record ? (
                <div style={{ color: "#ff8a80", marginTop: 6 }}>{record.error}</div>
              ) : (
                <>
                  <div style={{ fontSize: "0.78rem", marginTop: 6 }}>
                    {record.result.numberReturned ?? "?"} of {record.result.totalMatches ?? "?"} items
                  </div>
                  {record.result.items.length > 0 ? (
                    <ul style={{ paddingLeft: 18, margin: "8px 0" }}>
                      {record.result.items.slice(0, 12).map((item, itemIndex) => (
                        <li key={`${item.id}-${itemIndex}`} style={{ fontSize: "0.85rem", marginBottom: 4 }}>
                          <strong>{item.title}</strong>
                          {item.artist ? ` · ${item.artist}` : ""}
                          {item.uri ? <div style={{ fontSize: "0.7rem", color: "#aeb4ad", wordBreak: "break-all" }}><code>{item.uri}</code></div> : null}
                          <div style={{ fontSize: "0.7rem", color: "#8a8e88" }}>id: <code>{item.id}</code>{item.itemClass ? ` · class: ${item.itemClass}` : ""}</div>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <details>
                    <summary>Raw DIDL ({record.result.raw.length} bytes)</summary>
                    <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.7rem" }}>{record.result.raw}</pre>
                  </details>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const inputStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(242,240,232,0.18)",
  borderRadius: 6,
  color: "#f2f0e8",
  padding: "8px 10px",
  fontSize: "0.9rem",
  fontFamily: "inherit"
};

const buttonStyle: React.CSSProperties = {
  background: "rgba(145,211,196,0.18)",
  border: "1px solid rgba(145,211,196,0.5)",
  borderRadius: 6,
  color: "#f2f0e8",
  padding: "8px 14px",
  fontSize: "0.9rem",
  cursor: "pointer"
};

const presetButtonStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(242,240,232,0.18)",
  borderRadius: 999,
  color: "#f2f0e8",
  padding: "4px 10px",
  fontSize: "0.78rem",
  cursor: "pointer"
};

function maskToken(value: string | undefined): string {
  if (!value) return "—";
  if (value.length <= 12) return `${value.slice(0, 4)}…`;
  return `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`;
}

interface QueueListProps {
  queue: QueueItem[];
  activeIndex: number;
  isPlaying: boolean;
  onPlay: (index: number) => void;
}

function QueueList({ queue, activeIndex, isPlaying, onPlay }: QueueListProps) {
  const listRef = useRef<HTMLOListElement | null>(null);
  const activeItemRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (activeIndex < 0) return;
    const list = listRef.current;
    const item = activeItemRef.current;
    if (!list || !item) return;
    const itemRect = typeof item.getBoundingClientRect === "function" ? item.getBoundingClientRect() : null;
    const listRect = typeof list.getBoundingClientRect === "function" ? list.getBoundingClientRect() : null;
    if (!itemRect || !listRect) return;
    const itemTop = itemRect.top - listRect.top + list.scrollTop;
    const itemBottom = itemTop + itemRect.height;
    const viewTop = list.scrollTop;
    const viewBottom = viewTop + list.clientHeight;
    if (itemTop < viewTop || itemBottom > viewBottom) {
      const target = Math.max(0, Math.min(list.scrollHeight - list.clientHeight, itemTop - 16));
      if (typeof list.scrollTo === "function") {
        list.scrollTo({ top: target, behavior: "smooth" });
      } else {
        list.scrollTop = target;
      }
    }
  }, [activeIndex]);

  return (
    <ol className="queue-list" ref={listRef}>
      {queue.map((item, index) => {
        const isActive = index === activeIndex;
        return (
          <li
            key={`${item.id}-${index}`}
            ref={isActive ? activeItemRef : undefined}
            className={isActive ? "queue-item active" : "queue-item"}
          >
            <button type="button" onClick={() => onPlay(index)} aria-current={isActive ? "true" : undefined}>
              <span className="queue-indicator" aria-hidden="true">
                {isActive ? <AudioLines size={16} className={isPlaying ? "queue-indicator-active playing" : "queue-indicator-active"} /> : <span className="queue-track-number">{index + 1}</span>}
              </span>
              <span className="queue-meta">
                <span>{item.title}</span>
                <small>{[item.artist, item.album].filter(Boolean).join(" - ")}</small>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
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
  swallowFirstAdjustment?: boolean;
}

function VolumeControl({ label, value, muted, disabled = false, onChange, onMute, onSliderPointerDown, swallowFirstAdjustment = false }: VolumeControlProps) {
  const ignoreUntilRelease = useRef(false);
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
        onPointerDown={() => {
          if (swallowFirstAdjustment) ignoreUntilRelease.current = true;
          onSliderPointerDown?.();
        }}
        onPointerUp={() => { ignoreUntilRelease.current = false; }}
        onPointerCancel={() => { ignoreUntilRelease.current = false; }}
        onFocus={onSliderPointerDown}
        onChange={(event) => {
          if (ignoreUntilRelease.current) return;
          onChange(Number.parseInt(event.currentTarget.value, 10));
        }}
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
    durationLabel: durationSeconds > 0 ? formatDuration(durationSeconds) : "0:00",
    durationSeconds
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

const SELECTED_GROUP_STORAGE_KEY = "misonos:lastGroupKey";

function readStoredGroupKey(): string {
  if (typeof window === "undefined") return "";
  try { return window.localStorage.getItem(SELECTED_GROUP_STORAGE_KEY) ?? ""; } catch { return ""; }
}

function confirmVolumeJump(previous: number | undefined, next: number): boolean {
  if (typeof previous !== "number") return true;
  if (Math.abs(next - previous) <= 30) return true;
  return window.confirm(`Change volume from ${previous} to ${next}?`);
}

function membershipKey(group: SonosGroup): string {
  return group.zones
    .filter((zone) => zone.visible)
    .map((zone) => zone.uuid)
    .sort()
    .join("|");
}

function randomEditId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try { return crypto.randomUUID(); } catch { /* fall through */ }
  }
  return `edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
