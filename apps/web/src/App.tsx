import { ArrowLeft, AudioLines, Blend, Check, Heart, Library, ListEnd, ListPlus, Moon, MoreHorizontal, Pause, Pin, Play, Plus, RefreshCw, Repeat, Repeat1, RotateCcw, Settings, Shuffle, SkipBack, SkipForward, Upload, Volume2, VolumeX, X } from "lucide-react";
import { IconMusic } from "@tabler/icons-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BridgeSnapshot, EqPayload, EqPreset, EqPresetValues, EqState, NowPlaying, PlaybackState, QueueItem, RepeatMode, SonosGroup, SonosZone, SourceBrowseItem, TransportAction, VolumeState } from "@misonos/sonos-protocol";
import { BUILT_IN_EQ_PRESETS } from "@misonos/sonos-protocol";
import { bridgeApi, subscribeBridgeEvents } from "./api.js";
import { AddToPlaylistModal } from "./AddToPlaylistModal.js";
import { Alarms } from "./Alarms.js";
import { GroupDropdown } from "./GroupDropdown.js";
import { useDialogs } from "./dialogs.js";
import { useFavorites } from "./favorites.js";
import { useLocalPlayer, type LocalTrack } from "./localPlayer.js";
import { ServiceIcon, SourcePicker } from "./SourcePicker.js";
import { buildGroupOptions, type GroupOption } from "./groupPalette.js";
import { LAST_GROUP_PREF, LAST_SOURCE_PREF, MAX_VOLUME_PREF, SHOW_DEV_PANELS_PREF, loadPref, readLocalPref, setPref } from "./prefs.js";

const GroupEditor = lazy(() => import("./GroupEditor.js").then((module) => ({ default: module.GroupEditor })));
const LibraryView = lazy(() => import("./LibraryView.js").then((module) => ({ default: module.LibraryView })));

type LoadState = "idle" | "loading" | "ready" | "error";
type QueueState = "idle" | "loading" | "ready" | "error";
type PendingGroupEdit =
  | { id: string; type: "join"; zoneId: string; groupId: string }
  | { id: string; type: "standalone"; zoneId: string };

const LOCAL_DEVICE_ID = "local-device";
const DEVICE_OPTION: GroupOption = { id: LOCAL_DEVICE_ID, key: LOCAL_DEVICE_ID, name: "This device", color: "", zoneList: "Plays in this browser", device: true };

// Progress shape (matching playbackProgressFromNowPlaying) for the local player.
function localPlaybackProgress(position: number, duration: number) {
  const percent = duration > 0 ? Math.max(0, Math.min(100, (position / duration) * 100)) : 0;
  return {
    percent,
    positionLabel: formatDuration(position),
    durationLabel: duration > 0 ? formatDuration(duration) : "0:00",
    durationSeconds: duration
  };
}

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
  const [view, setView] = useState<"main" | "settings" | "browse" | "editor" | "library">("main");
  const [artworkFullscreen, setArtworkFullscreen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [message, setMessage] = useState("Ready");
  const [groupPlayback, setGroupPlayback] = useState<Record<string, PlaybackState>>({});
  const [showDevPanels, setShowDevPanels] = useState<boolean>(() => readLocalPref(SHOW_DEV_PANELS_PREF) ?? false);
  // Volume ceiling (0–100): the sliders span 0..maxVolume, so the controller can't go louder.
  const [maxVolume, setMaxVolume] = useState<number>(() => readLocalPref(MAX_VOLUME_PREF) ?? 100);
  const dialogs = useDialogs();
  const favorites = useFavorites();
  const localPlayer = useLocalPlayer();
  // "This device" is a synthetic Play-to target: when selected, playback/now-playing/
  // queue/volume route to the in-browser player instead of a Sonos group.
  const localMode = selectedGroupId === LOCAL_DEVICE_ID;
  // Confirm a large (>30) volume jump — e.g. an accidental tap on the slider track.
  const confirmVolumeJump = useCallback(async (previous: number | undefined, next: number) => {
    if (typeof previous !== "number" || Math.abs(next - previous) <= 30) return true;
    return dialogs.confirm({ message: `Change volume from ${previous}% to ${next}%?`, confirmLabel: "Change volume" });
  }, [dialogs]);
  // sourceId → version token for user-uploaded service logos (shared by the source
  // dropdown and the Settings upload widget); the token busts the browser cache.
  const [customIcons, setCustomIcons] = useState<Record<string, string>>({});
  const groupEditQueueRef = useRef<PendingGroupEdit[]>([]);
  const groupEditProcessingRef = useRef(false);
  // Best-known "last selected group" membership key — seeded synchronously from the
  // local cache, then refreshed from the shared bridge store on mount.
  const storedGroupKeyRef = useRef<string>(readStoredGroupKey());

  const refreshCustomIcons = useCallback(async () => {
    try {
      const metas = await bridgeApi.sourceIcons();
      setCustomIcons(Object.fromEntries(metas.map((meta) => [meta.sourceId, meta.updatedAt])));
    } catch {
      /* custom logos are optional — ignore load failures */
    }
  }, []);

  useEffect(() => { void refreshCustomIcons(); }, [refreshCustomIcons]);

  const displayGroups = useMemo(() => {
    const next = applyPendingGroupEdits(groups, pendingGroupEdits);
    return [...next].sort((a, b) => membershipKey(a).localeCompare(membershipKey(b)));
  }, [groups, pendingGroupEdits]);

  const selectedGroup = useMemo(
    () => (localMode ? undefined : groups.find((group) => group.id === selectedGroupId) ?? groups[0]),
    [groups, selectedGroupId, localMode]
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

  // In device mode the now-playing/queue/transport/volume bind to the local player;
  // otherwise to the selected Sonos group. `transportEnabled` gates the controls.
  const transportEnabled = localMode ? localPlayer.active : !!selectedGroup;
  const effectiveNowPlaying = localMode ? localPlayer.nowPlaying : nowPlaying;
  const effectivePlaying = localMode ? localPlayer.playing : nowPlaying?.state === "PLAYING";
  const effectiveProgress = localMode ? localPlaybackProgress(localPlayer.position, localPlayer.duration) : playbackProgress;
  const effectiveQueue = localMode ? localPlayer.queue : queue;
  const effectiveActiveIndex = localMode ? localPlayer.activeIndex : activeQueueIndex;
  const effectiveVolumeValue = localMode ? localPlayer.volume : (primaryVolume?.volume ?? 0);
  const effectiveMuted = localMode ? localPlayer.muted : (primaryVolume?.muted ?? false);
  // A live stream (e.g. TuneIn radio) reports no duration and is a single endless
  // "track": there's nothing to seek, skip, repeat, shuffle, crossfade, or queue.
  // Collapse the now-playing UI to just play/pause, volume, sleep, and favorite.
  const isLiveStream = !!effectiveNowPlaying && effectiveProgress.durationSeconds === 0;
  const activeQueueItem = effectiveActiveIndex >= 0 ? effectiveQueue[effectiveActiveIndex] : undefined;
  const onPlayPause = () => { if (localMode) localPlayer.toggle(); else void runTransport(effectivePlaying ? "pause" : "play"); };
  const onPrevTrack = () => { if (localMode) localPlayer.prev(); else void runTransport("previous"); };
  const onNextTrack = () => { if (localMode) localPlayer.next(); else void runTransport("next"); };
  const onSeekTo = (seconds: number) => { if (localMode) localPlayer.seek(seconds); else void runSeek(seconds); };
  const onPrimaryVolume = (volume: number) => { if (localMode) localPlayer.setVolume(volume); else void setPrimaryVolume(volume); };
  const onPrimaryMute = () => { if (localMode) localPlayer.toggleMute(); else void togglePrimaryMute(); };
  const onQueuePlay = (index: number) => { if (localMode) localPlayer.playIndex(index); else void playQueueItem(index + 1); };
  const onQueueRemove = (index: number) => { if (localMode) localPlayer.removeIndex(index); else void removeQueueItem(index); };

  const applySnapshot = useCallback((snapshot: BridgeSnapshot) => {
    setGroups((current) => (groupsTopologyKey(current) === groupsTopologyKey(snapshot.groups) ? current : snapshot.groups));
    setSelectedGroupId((current) => {
      if (current === LOCAL_DEVICE_ID) return current; // synthetic device target — not a Sonos group
      if (current && snapshot.groups.some((group) => group.id === current)) return current;
      const stored = storedGroupKeyRef.current;
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
    const key = membershipKey(group);
    storedGroupKeyRef.current = key;
    setPref(LAST_GROUP_PREF, key);
  }, [selectedGroupId, groups]);

  // Hydrate cross-device preferences from the shared bridge store once on mount.
  useEffect(() => {
    let cancelled = false;
    void loadPref(LAST_GROUP_PREF).then((value) => {
      if (!cancelled && value) storedGroupKeyRef.current = value;
    });
    void loadPref(SHOW_DEV_PANELS_PREF).then((value) => {
      if (!cancelled && value !== null) setShowDevPanels(value);
    });
    void loadPref(MAX_VOLUME_PREF).then((value) => {
      if (!cancelled && value !== null) setMaxVolume(Math.min(100, Math.max(0, value)));
    });
    return () => { cancelled = true; };
  }, []);

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
    if (localMode) return; // device target loads no Sonos now-playing/queue
    void loadNowPlaying(selectedGroupId);
    void loadQueue(selectedGroupId);
  }, [loadNowPlaying, loadQueue, selectedGroupId, localMode]);

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

  // Per-group playback state, so the group dropdown can show which rooms are playing
  // and offer a quick play/pause for each. Refreshed on topology change and on open.
  const loadGroupPlayback = useCallback(async (groupList: SonosGroup[]) => {
    const entries = await Promise.all(groupList.map(async (group): Promise<readonly [string, PlaybackState]> => {
      try {
        return [group.id, (await bridgeApi.nowPlaying(group.id)).state];
      } catch {
        return [group.id, "UNKNOWN"];
      }
    }));
    setGroupPlayback(Object.fromEntries(entries));
  }, []);

  useEffect(() => {
    if (groups.length > 0) void loadGroupPlayback(groups);
  }, [groups, loadGroupPlayback]);

  // Keep the selected group's entry live from its (SSE/poll-driven) now-playing updates.
  useEffect(() => {
    if (nowPlaying) setGroupPlayback((current) => ({ ...current, [nowPlaying.groupId]: nowPlaying.state }));
  }, [nowPlaying]);

  const toggleGroupPlayback = useCallback(async (groupId: string, action: TransportAction) => {
    try {
      const next = await bridgeApi.transport(groupId, action);
      setGroupPlayback((current) => ({ ...current, [groupId]: next.state }));
      setNowPlaying((current) => (current && current.groupId === groupId ? next : current));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not change playback");
    }
  }, []);

  const pauseAllGroups = useCallback(async () => {
    localPlayer.pause(); // "all zones" includes the in-browser device
    const targets = groups.filter((group) => groupPlayback[group.id] === "PLAYING");
    await Promise.all(targets.map((group) =>
      bridgeApi.transport(group.id, "pause")
        .then((next) => setGroupPlayback((current) => ({ ...current, [group.id]: next.state })))
        .catch(() => null)
    ));
    setNowPlaying((current) => (current && current.state === "PLAYING" ? { ...current, state: "PAUSED_PLAYBACK" } : current));
  }, [groups, groupPlayback, localPlayer]);

  const runSeek = async (positionSeconds: number) => {
    if (!selectedGroup) return;
    setNowPlaying(await bridgeApi.seek(selectedGroup.id, positionSeconds));
    void loadNowPlaying(selectedGroup.id);
  };

  const cycleRepeat = async () => {
    if (!selectedGroup) return;
    const order: RepeatMode[] = ["none", "all", "one"];
    const next = order[(order.indexOf(nowPlaying?.repeat ?? "none") + 1) % order.length];
    setNowPlaying(await bridgeApi.setPlayMode(selectedGroup.id, next, nowPlaying?.shuffle ?? false));
  };

  const toggleShuffle = async () => {
    if (!selectedGroup) return;
    setNowPlaying(await bridgeApi.setPlayMode(selectedGroup.id, nowPlaying?.repeat ?? "none", !(nowPlaying?.shuffle ?? false)));
  };

  const toggleCrossfade = async () => {
    if (!selectedGroup) return;
    setNowPlaying(await bridgeApi.setCrossfade(selectedGroup.id, !(nowPlaying?.crossfade ?? false)));
  };

  const setSleep = async (seconds: number) => {
    if (!selectedGroup) return;
    setNowPlaying(await bridgeApi.setSleepTimer(selectedGroup.id, seconds));
  };

  const saveQueueAsPlaylist = async () => {
    if (!selectedGroup) return;
    const name = (await dialogs.prompt({ message: "Save current queue as playlist:", placeholder: "Playlist name", confirmLabel: "Save" }))?.trim();
    if (!name) return;
    try {
      const result = await bridgeApi.savePlaylistFromQueue(name, selectedGroup.id);
      const skip = result.skipped > 0 ? ` (${result.skipped} not from a known source, skipped)` : "";
      setMessage(`Saved ${result.saved} ${result.saved === 1 ? "track" : "tracks"} to “${result.playlist.name}”${skip}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save queue");
    }
  };

  const setZoneVolume = async (zoneId: string, volume: number) => {
    const previous = zoneVolumes[zoneId]?.volume;
    if (!(await confirmVolumeJump(previous, volume))) return;
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
    if (!(await confirmVolumeJump(groupVolume?.volume, volume))) return;
    setGroupVolume(await bridgeApi.setGroupVolume(selectedGroup.id, { volume }));
    void loadVolumes(selectedGroup);
  };

  // When the user lowers the volume cap, pull any currently-louder rooms down to it so
  // the ceiling takes effect immediately (and the sliders aren't stuck above their max).
  const enforceVolumeCap = useCallback(async (cap: number) => {
    const overZones = Object.values(zoneVolumes).filter((entry) => entry.volume > cap);
    await Promise.all(overZones.map(async (entry) => {
      const next = await bridgeApi.volume(entry.id, { volume: cap });
      setZoneVolumes((current) => ({ ...current, [next.id]: next }));
    }));
    if (selectedGroup && groupVolume && groupVolume.volume > cap) {
      setGroupVolume(await bridgeApi.setGroupVolume(selectedGroup.id, { volume: cap }));
      void loadVolumes(selectedGroup);
    }
  }, [zoneVolumes, selectedGroup, groupVolume, loadVolumes]);

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

  const removeQueueItem = async (index: number) => {
    if (!selectedGroup) return;
    setQueue(await bridgeApi.removeQueueTrack(selectedGroup.id, index));
  };

  const queueItemFavorited = (item: QueueItem): boolean =>
    !!(item.sourceId && item.trackId) && favorites.isFavorited(item.sourceId, item.trackId);

  const toggleQueueFavorite = async (item: QueueItem) => {
    if (!item.sourceId || !item.trackId) return;
    try {
      const nowFavorited = await favorites.toggle({
        sourceId: item.sourceId, itemId: item.trackId, kind: "track",
        title: item.title, artist: item.artist ?? null, album: item.album ?? null
      });
      setMessage(nowFavorited ? `Favorited “${item.title}”.` : `Removed “${item.title}” from favorites.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not update favorite");
    }
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

  const groupOptions = [...buildGroupOptions(displayGroups), DEVICE_OPTION];
  const selectedGroupOption = groupOptions.find((option) => option.id === (selectedGroupId || selectedGroup?.id)) ?? groupOptions[0];
  const targetPlayback = { ...groupPlayback, [LOCAL_DEVICE_ID]: (localPlayer.playing ? "PLAYING" : "PAUSED_PLAYBACK") as PlaybackState };
  const primaryVolumeLabel = selectedGroup && selectedVisibleZones.length > 1
    ? `${selectedGroupOption?.name ?? "Group"} group`
    : selectedPrimaryZone?.name ?? "Selected room";

  return (
    <main className="app-shell">
      <header className={`topbar ${view === "main" ? "compact main" : "compact"}`}>
        {view === "main" ? (
          <>
            <GroupDropdown
              options={groupOptions}
              selectedId={selectedGroupId || selectedGroup?.id}
              selectedOption={selectedGroupOption}
              onSelect={setSelectedGroupId}
              onEditGroups={() => setView("editor")}
              playback={targetPlayback}
              onTogglePlay={(groupId, playing) => { if (groupId === LOCAL_DEVICE_ID) localPlayer.toggle(); else void toggleGroupPlayback(groupId, playing ? "pause" : "play"); }}
              onPauseAll={() => void pauseAllGroups()}
              onOpen={() => { if (groups.length > 0) void loadGroupPlayback(groups); }}
            />
            <div className="topbar-actions">
              <button className="icon-button" type="button" title="Browse music sources" aria-label="Browse music sources" onClick={() => setView("browse")}>
                <IconMusic size={18} />
              </button>
              <button className="icon-button" type="button" title="Library (favorites & playlists)" aria-label="Library" onClick={() => setView("library")}>
                <Library size={18} />
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
            <span className="topbar-title">{view === "settings" ? "Settings" : view === "browse" ? "Music" : view === "library" ? "Library" : "Group Editor"}</span>
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
          selectedGroupId={selectedGroupId || selectedGroup?.id}
          onSelectGroup={setSelectedGroupId}
          customIcons={customIcons}
        />
      </section>

      {view === "settings" ? (
        <section className="settings-page" aria-label="Settings">
          <Preferences
            showDevPanels={showDevPanels}
            onShowDevPanelsChange={(value) => {
              setShowDevPanels(value);
              setPref(SHOW_DEV_PANELS_PREF, value);
            }}
            maxVolume={maxVolume}
            onMaxVolumeChange={(value) => {
              setMaxVolume(value);
              setPref(MAX_VOLUME_PREF, value);
            }}
            onMaxVolumeCommit={(value) => void enforceVolumeCap(value)}
          />
          <SourceLogoSettings customIcons={customIcons} onChanged={() => void refreshCustomIcons()} />
          <Equalizer zones={displayGroups.flatMap((group) => group.zones).filter((zone) => zone.visible)} />
          <Alarms zones={displayGroups.flatMap((group) => group.zones).filter((zone) => zone.visible)} />
          <AboutSystem />
          <YouTubeMusicAuth />
          <CustomMusicServices zones={displayGroups.flatMap((group) => group.zones).filter((zone) => zone.visible)} />
          {showDevPanels ? (
            <>
              <MusicServicesDebug />
              <BrowseDebug />
            </>
          ) : null}
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
      ) : view === "library" ? (
        <section className="settings-page" aria-label="Library">
          <Suspense fallback={<div className="empty-panel">Loading library...</div>}>
            <LibraryView
              groups={displayGroups}
              selectedGroupId={selectedGroup?.id}
              onSelectGroup={setSelectedGroupId}
            />
          </Suspense>
        </section>
      ) : view === "main" ? (
      <section className="controller-grid main-view">
        <section className="now-playing" aria-label="Now playing">
          <button
            type="button"
            className="artwork-frame"
            aria-label="Expand album art"
            onClick={() => setArtworkFullscreen(true)}
          >
            {effectiveNowPlaying?.albumArtUri ? <img src={effectiveNowPlaying.albumArtUri} alt="" /> : <div className="artwork-fallback">Mi</div>}
          </button>
          <div className="track-copy">
            <p className="eyebrow">{localMode ? "ON THIS DEVICE" : effectiveNowPlaying?.state ?? "UNKNOWN"}</p>
            <h2>{effectiveNowPlaying?.title ?? "Nothing selected"}</h2>
            <p>{[effectiveNowPlaying?.artist, effectiveNowPlaying?.album].filter(Boolean).join(" - ")}</p>
            {/* Live streams (e.g. TuneIn radio) report no duration and can't be
                seeked, so the scrub bar would be meaningless — hide it entirely. */}
            {effectiveProgress.durationSeconds > 0 && (
              <div className="progress-copy">
                <span>{effectiveProgress.positionLabel}</span>
                <button
                  type="button"
                  className="playback-progress"
                  role="meter"
                  aria-label="Playback progress (click to seek)"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(effectiveProgress.percent)}
                  disabled={!transportEnabled || !effectiveProgress.durationSeconds}
                  onClick={(event) => {
                    if (!effectiveProgress.durationSeconds) return;
                    const target = event.currentTarget.getBoundingClientRect();
                    const ratio = Math.max(0, Math.min(1, (event.clientX - target.left) / target.width));
                    onSeekTo(Math.round(ratio * effectiveProgress.durationSeconds));
                  }}
                >
                  <span style={{ width: `${effectiveProgress.percent}%` }} />
                </button>
                <span>{effectiveProgress.durationLabel}</span>
              </div>
            )}
          </div>
          <div className="transport-bar">
            {!isLiveStream && (
              <button className="icon-button large" type="button" title="Previous" aria-label="Previous" disabled={!transportEnabled} onClick={onPrevTrack}>
                <SkipBack size={22} />
              </button>
            )}
            <button
              className="icon-button large primary"
              type="button"
              title={effectivePlaying ? "Pause" : "Play"}
              aria-label={effectivePlaying ? "Pause" : "Play"}
              disabled={!transportEnabled}
              onClick={onPlayPause}
            >
              {effectivePlaying ? <Pause size={22} /> : <Play size={24} />}
            </button>
            {!isLiveStream && (
              <button className="icon-button large" type="button" title="Next" aria-label="Next" disabled={!transportEnabled} onClick={onNextTrack}>
                <SkipForward size={22} />
              </button>
            )}
          </div>
          {!localMode ? (
          <div className="transport-modes">
            {isLiveStream ? (
              <button
                className={`icon-button mode${activeQueueItem && queueItemFavorited(activeQueueItem) ? " active" : ""}`}
                type="button"
                title={activeQueueItem && queueItemFavorited(activeQueueItem) ? "Remove favorite" : "Add favorite"}
                aria-label="Toggle favorite"
                disabled={!selectedGroup || !activeQueueItem?.sourceId || !activeQueueItem?.trackId}
                onClick={() => activeQueueItem && void toggleQueueFavorite(activeQueueItem)}
              >
                <Heart size={16} fill={activeQueueItem && queueItemFavorited(activeQueueItem) ? "currentColor" : "none"} />
              </button>
            ) : (
              <>
                <button
                  className={`icon-button mode${nowPlaying?.repeat && nowPlaying.repeat !== "none" ? " active" : ""}`}
                  type="button"
                  title={nowPlaying?.repeat === "one" ? "Repeat one" : nowPlaying?.repeat === "all" ? "Repeat all" : "Repeat off"}
                  aria-label="Cycle repeat mode"
                  disabled={!selectedGroup}
                  onClick={() => void cycleRepeat()}
                >
                  {nowPlaying?.repeat === "one" ? <Repeat1 size={16} /> : <Repeat size={16} />}
                </button>
                <button
                  className={`icon-button mode${nowPlaying?.shuffle ? " active" : ""}`}
                  type="button"
                  title={nowPlaying?.shuffle ? "Shuffle on" : "Shuffle off"}
                  aria-label="Toggle shuffle"
                  disabled={!selectedGroup}
                  onClick={() => void toggleShuffle()}
                >
                  <Shuffle size={16} />
                </button>
                <button
                  className={`icon-button mode${nowPlaying?.crossfade ? " active" : ""}`}
                  type="button"
                  title={nowPlaying?.crossfade ? "Crossfade on" : "Crossfade off"}
                  aria-label="Toggle crossfade"
                  disabled={!selectedGroup}
                  onClick={() => void toggleCrossfade()}
                >
                  <Blend size={16} />
                </button>
              </>
            )}
            <SleepTimer
              remainingSeconds={nowPlaying?.sleepTimerSeconds}
              disabled={!selectedGroup}
              onSet={(seconds) => void setSleep(seconds)}
            />
          </div>
          ) : null}
          <div className="playback-volume">
            <VolumeControl
              label={localMode ? "This device" : primaryVolumeLabel}
              value={effectiveVolumeValue}
              muted={effectiveMuted}
              maxVolume={maxVolume}
              disabled={localMode ? !localPlayer.active : !primaryVolume}
              onChange={onPrimaryVolume}
              onMute={onPrimaryMute}
              swallowFirstAdjustment={!localMode && selectedVisibleZones.length > 1 && !volumePopoverOpen}
              onSliderPointerDown={() => {
                if (!localMode && selectedVisibleZones.length > 1) setVolumePopoverOpen(true);
              }}
            />
            {!localMode && selectedGroup && selectedVisibleZones.length > 1 && volumePopoverOpen ? (
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
                      maxVolume={maxVolume}
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

        {!isLiveStream && (
        <section className="queue-panel" aria-label="Queue">
          <div className="section-heading">
            <h2>Queue</h2>
            <div className="heading-actions">
              <button
                className="icon-button compact"
                type="button"
                title="Save queue as playlist"
                aria-label="Save queue as playlist"
                disabled={effectiveQueue.length === 0 || localMode || !selectedGroup}
                onClick={() => void saveQueueAsPlaylist()}
              >
                <Plus size={16} />
              </button>
              <span>{effectiveQueue.length}</span>
            </div>
          </div>
          {!localMode && queueState === "loading" ? (
            <div className="empty-panel">Loading queue...</div>
          ) : !localMode && queueState === "error" ? (
            <div className="empty-panel error-panel">
              <span>{queueError}</span>
              <button type="button" onClick={() => selectedGroup && void loadQueue(selectedGroup.id)}>Retry</button>
            </div>
          ) : effectiveQueue.length === 0 ? (
            <div className="empty-panel">{localMode ? "Nothing playing on this device yet." : "No queue items for this group."}</div>
          ) : (
            <QueueList
              queue={effectiveQueue}
              activeIndex={effectiveActiveIndex}
              isPlaying={effectivePlaying}
              onPlay={(index) => onQueuePlay(index)}
              onRemove={(index) => onQueueRemove(index)}
              isFavorite={queueItemFavorited}
              onFavorite={(item) => void toggleQueueFavorite(item)}
            />
          )}
        </section>
        )}
      </section>
      ) : null}
      {artworkFullscreen && nowPlaying?.albumArtUri ? (
        <div className="artwork-overlay" role="dialog" aria-label="Now playing artwork" onClick={() => setArtworkFullscreen(false)}>
          <button
            type="button"
            className="artwork-overlay-close"
            aria-label="Close"
            onClick={(event) => { event.stopPropagation(); setArtworkFullscreen(false); }}
          >
            <X size={22} />
          </button>
          <img src={nowPlaying.albumArtUri} alt="" />
          <div className="artwork-overlay-meta">
            <h2>{nowPlaying.title}</h2>
            <p>{[nowPlaying.artist, nowPlaying.album].filter(Boolean).join(" - ")}</p>
          </div>
        </div>
      ) : null}
    </main>
  );
}

interface SourceBrowserProps {
  groups: SonosGroup[];
  selectedGroupId?: string;
  onSelectGroup: (groupId: string) => void;
  customIcons: Record<string, string>;
}

interface BrowseCrumb {
  id: string;
  title: string;
}

function BrowseThumb({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span className="browse-thumb browse-thumb-empty" aria-hidden="true">♪</span>;
  return <img className="browse-thumb" src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

function SourceBrowser({ groups, selectedGroupId, onSelectGroup, customIcons }: SourceBrowserProps) {
  const [sources, setSources] = useState<Awaited<ReturnType<typeof bridgeApi.listSources>> | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(() => readLocalPref(LAST_SOURCE_PREF));
  const sourceInitializedRef = useRef(false);
  const favorites = useFavorites();
  const localPlayer = useLocalPlayer();
  const [menu, setMenu] = useState<{ item: SourceBrowseItem; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  // The action menu opens at the click point, which is near the right edge for the
  // "…" button — nudge it back on-screen after measuring its rendered size.
  useLayoutEffect(() => {
    if (!menu) { setMenuPos(null); return; }
    const rect = menuRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 8;
    let left = menu.x;
    let top = menu.y;
    const overflowX = rect.right - (window.innerWidth - margin);
    if (overflowX > 0) left -= overflowX;
    const overflowY = rect.bottom - (window.innerHeight - margin);
    if (overflowY > 0) top -= overflowY;
    setMenuPos({ left: Math.max(margin, left), top: Math.max(margin, top) });
  }, [menu]);
  const [addTo, setAddTo] = useState<SourceBrowseItem | null>(null);

  const persistSourceId = useCallback((id: string) => {
    setSourceId(id);
    setPref(LAST_SOURCE_PREF, id);
  }, []);
  const [stack, setStack] = useState<BrowseCrumb[]>([]);
  const crumbsRef = useRef<HTMLElement | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Session cache of browse results, keyed by source + container id; evicted per-key
  // by the refresh button so revisiting a level is instant.
  const browseCache = useRef<Map<string, Awaited<ReturnType<typeof bridgeApi.browseSource>>>>(new Map());

  // Keep the current location (rightmost crumb) in view as the trail grows.
  useEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [stack]);
  useEffect(() => {
    const onAuthChange = (event: Event) => {
      const changed = (event as CustomEvent<{ sourceId?: string }>).detail?.sourceId;
      // Evict the changed source's cached entries regardless of what's currently
      // selected, so switching back to it doesn't serve a stale (pre-auth-change)
      // list. Only force an immediate refetch when that source is on screen.
      if (changed) {
        for (const key of [...browseCache.current.keys()]) {
          if (key.startsWith(`${changed}:`)) browseCache.current.delete(key);
        }
        if (changed === sourceId) setRefreshNonce((n) => n + 1);
      } else {
        browseCache.current.clear();
        setRefreshNonce((n) => n + 1);
      }
    };
    window.addEventListener("misonos:source-auth-changed", onAuthChange);
    return () => window.removeEventListener("misonos:source-auth-changed", onAuthChange);
  }, [sourceId]);

  // The backend can drop YouTube Music cookies on its own (a 401/403 expires them),
  // possibly triggered from another tab/device. Poll auth status INDEPENDENTLY of the
  // selected source so the baseline never resets and the transition is caught wherever
  // it happens; on a drop, fire the event that evicts the (source-keyed) YT cache.
  const lastCookieAuthRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const status = await bridgeApi.sourceAuthStatus("youtube-music");
        if (cancelled) return;
        const prev = lastCookieAuthRef.current;
        lastCookieAuthRef.current = status.cookieAuth;
        const dropped = prev === "signed-in" && status.cookieAuth === "signed-out";
        // First sample: if already signed-out but we still hold cached YT entries,
        // they may be stale signed-in results from before — evict them too.
        const staleFirstSample = prev === undefined && status.cookieAuth === "signed-out"
          && [...browseCache.current.keys()].some((key) => key.startsWith("youtube-music:"));
        if (dropped || staleFirstSample) {
          window.dispatchEvent(new CustomEvent("misonos:source-auth-changed", { detail: { sourceId: "youtube-music" } }));
        }
      } catch { /* transient — ignore */ }
    };
    void check();
    const interval = window.setInterval(() => void check(), 60000);
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; window.clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

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
  const [searchType, setSearchType] = useState<"song" | "artist" | "album">("song");

  const activeSource = sources?.find((entry) => entry.id === sourceId);
  const supportsSearch = activeSource?.capabilities?.includes("search") ?? false;
  const supportsTypedSearch = sourceId === "youtube-music";
  const supportsPin = activeSource?.capabilities?.includes("pin") ?? false;

  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!sourceId || !supportsPin) { setPinnedIds(new Set()); return; }
    let cancelled = false;
    void bridgeApi.sourceSubscriptions(sourceId)
      .then((result) => { if (!cancelled) setPinnedIds(new Set(result.ids)); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [sourceId, supportsPin, refreshNonce]);

  const togglePin = useCallback(async (item: SourceBrowseItem) => {
    if (!sourceId) return;
    const pinned = pinnedIds.has(item.id);
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (pinned) next.delete(item.id); else next.add(item.id);
      return next;
    });
    try {
      await bridgeApi.pinSource(sourceId, item.id, !pinned);
      // Pinned shows drive the root + New Episodes lists, so refetch those next time.
      browseCache.current.delete(`${sourceId}:root`);
      browseCache.current.delete(`${sourceId}:new`);
    } catch {
      // Revert on failure.
      setPinnedIds((prev) => {
        const next = new Set(prev);
        if (pinned) next.add(item.id); else next.delete(item.id);
        return next;
      });
    }
  }, [sourceId, pinnedIds]);

  const browseGroupOptions = useMemo(() => [...buildGroupOptions(groups), DEVICE_OPTION], [groups]);

  const runSearch = useCallback(async (overrideType?: "song" | "artist" | "album") => {
    if (!sourceId || !searchQuery.trim()) return;
    setLoading(true);
    setError("");
    setSearchActive(true);
    setStack([]); // search is a fresh context — drop the browse breadcrumb trail
    const type = supportsTypedSearch ? (overrideType ?? searchType) : undefined;
    try {
      const next = await bridgeApi.searchSource(sourceId, searchQuery.trim(), type);
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }, [sourceId, searchQuery, searchType, supportsTypedSearch]);

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
        if (next.length === 0) return;
        if (!sourceInitializedRef.current) {
          // First load: prefer the shared bridge value (falling back to the local cache),
          // so a source picked on another device carries over here.
          sourceInitializedRef.current = true;
          const preferred = await loadPref(LAST_SOURCE_PREF);
          const chosen = preferred && next.some((entry) => entry.id === preferred) ? preferred : next[0].id;
          persistSourceId(chosen);
          return;
        }
        const stillExists = sourceId ? next.some((entry) => entry.id === sourceId) : false;
        if (!stillExists) persistSourceId(next[0].id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load sources");
      }
    })();
  }, [sourceId, persistSourceId]);

  useEffect(() => {
    if (!sourceId || searchActive) return;
    // Ignore a stale in-flight response when the view changes again before it lands,
    // so a slow browse can't overwrite a newer one (e.g. navigating back to root).
    let cancelled = false;
    const id = stack.length > 0 ? stack[stack.length - 1].id : undefined;
    const cacheKey = `${sourceId}:${id ?? "root"}`;
    // Show cached results instantly on revisit; the refresh button evicts the key so
    // it refetches (e.g. to regenerate a Supermix). Browse results rarely change
    // moment-to-moment, so caching avoids a slow round-trip on every navigation.
    const cached = browseCache.current.get(cacheKey);
    if (cached) {
      setData(cached);
      setLoading(false);
      setError("");
      return;
    }
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const next = await bridgeApi.browseSource(sourceId, id);
        if (cancelled) return;
        browseCache.current.set(cacheKey, next);
        setData(next);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to browse");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sourceId, stack, searchActive, refreshNonce]);

  const drill = useCallback((item: { id: string; title: string }) => {
    setSearchActive(false);
    setStack((current) => [...current, { id: item.id, title: item.title }]);
  }, []);

  const pop = useCallback((targetIndex: number) => {
    setStack((current) => current.slice(0, targetIndex));
  }, []);

  // Favorites are global; load once into a Set so rows can show favorited state.
  const isFavorited = (item: SourceBrowseItem): boolean => !!sourceId && favorites.isFavorited(sourceId, item.id);

  const toggleFavorite = useCallback(async (item: SourceBrowseItem) => {
    if (!sourceId) return;
    // Album rows can be containers (e.g. YouTube Music `album:…`) or kind "album".
    const kind = item.kind === "album" || item.id.startsWith("album:") ? "album" : "track";
    try {
      const nowFavorited = await favorites.toggle({
        sourceId, itemId: item.id, kind, title: item.title, subtitle: item.subtitle, artist: item.artist, album: item.album
      });
      setStatus({ ok: true, message: nowFavorited ? `Favorited “${item.title}”.` : `Removed “${item.title}” from favorites.` });
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Could not update favorite" });
    }
  }, [sourceId, favorites]);

  // Expand a browse item to playable LocalTracks (single track, or an album/container's
  // children) for the "This device" target.
  const buildLocalTracks = useCallback(async (item: SourceBrowseItem): Promise<LocalTrack[]> => {
    if (!sourceId) return [];
    if (item.kind === "playable") {
      return [{ sourceId, trackId: item.id, title: item.title, artist: item.artist, album: item.album, albumArtUri: item.albumArtUri }];
    }
    const expansion = await bridgeApi.browseSource(sourceId, item.id);
    return expansion.items
      .filter((entry) => entry.kind === "playable")
      .map((entry) => ({ sourceId, trackId: entry.id, title: entry.title, artist: entry.artist, album: entry.album, albumArtUri: entry.albumArtUri }));
  }, [sourceId]);

  const verbFor = (mode: "replace" | "next" | "end") => mode === "replace" ? "Playing" : mode === "next" ? "Queued next:" : "Queued at end:";

  const enqueueAll = useCallback(async (mode: "replace" | "next" | "end") => {
    if (!sourceId || !selectedGroupId) {
      setStatus({ ok: false, message: "Pick a target first." });
      return;
    }
    setPlaying(`all:${mode}`);
    setStatus(null);
    try {
      if (selectedGroupId === LOCAL_DEVICE_ID) {
        const tracks: LocalTrack[] = (data?.items ?? [])
          .filter((entry) => entry.kind === "playable").slice(0, 100)
          .map((entry) => ({ sourceId, trackId: entry.id, title: entry.title, artist: entry.artist, album: entry.album, albumArtUri: entry.albumArtUri }));
        if (tracks.length === 0) { setStatus({ ok: false, message: "No playable tracks in this view." }); return; }
        localPlayer.enqueue(tracks, mode);
        setStatus({ ok: true, message: `${verbFor(mode)} ${tracks.length} tracks on this device.` });
        return;
      }
      const allTrackIds = (data?.items ?? []).filter((entry) => entry.kind === "playable").map((entry) => entry.id).slice(0, 100);
      if (allTrackIds.length === 0) { setStatus({ ok: false, message: "No playable tracks in this view." }); return; }
      await bridgeApi.playSourceItems(sourceId, { trackIds: allTrackIds, groupId: selectedGroupId, mode });
      setStatus({ ok: true, message: `${verbFor(mode)} ${allTrackIds.length} tracks.` });
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Action failed" });
    } finally {
      setPlaying(null);
    }
  }, [sourceId, selectedGroupId, data, localPlayer]);

  const enqueueItem = useCallback(async (item: SourceBrowseItem, mode: "replace" | "next" | "end") => {
    if (!sourceId || !selectedGroupId) {
      setStatus({ ok: false, message: "Pick a target first." });
      return;
    }
    setPlaying(`${item.id}:${mode}`);
    setStatus(null);
    try {
      if (selectedGroupId === LOCAL_DEVICE_ID) {
        const tracks = await buildLocalTracks(item);
        if (tracks.length === 0) { setStatus({ ok: false, message: `“${item.title}” has no playable tracks.` }); return; }
        localPlayer.enqueue(tracks, mode);
        const label = tracks.length === 1 ? `“${item.title}”` : `${tracks.length} tracks from “${item.title}”`;
        setStatus({ ok: true, message: `${verbFor(mode)} ${label} on this device.` });
        return;
      }
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
      setStatus({ ok: true, message: `${verbFor(mode)} ${label}.` });
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Action failed" });
    } finally {
      setPlaying(null);
    }
  }, [sourceId, selectedGroupId, buildLocalTracks, localPlayer]);

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
          <SourcePicker
            sources={sources ?? []}
            value={sourceId}
            onChange={(id) => { persistSourceId(id); setStack([]); clearSearch(); }}
            customIcons={customIcons}
          />
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
      </div>
      {supportsSearch ? (
        <div className="browse-search-label">
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
              enterKeyHint="search"
            />
            {searchActive ? (
              <button type="button" onClick={clearSearch} className="browse-search-clear">Clear</button>
            ) : null}
          </form>
          {supportsTypedSearch ? (
            <div className="browse-search-types" role="tablist">
              {([
                { value: "artist", label: "Artists" },
                { value: "song", label: "Songs" },
                { value: "album", label: "Albums" }
              ] as const).map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  role="tab"
                  aria-selected={searchType === entry.value}
                  className={searchType === entry.value ? "selected" : undefined}
                  onClick={() => {
                    setSearchType(entry.value);
                    if (searchQuery.trim()) void runSearch(entry.value);
                  }}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

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

      <nav className="browse-crumbs" aria-label="Path" ref={crumbsRef}>
        {stack.length === 0 ? (
          <span className="browse-crumb-placeholder" aria-hidden="true" />
        ) : (
          <button type="button" className="browse-crumb-reset" aria-label="Return to root" onClick={() => pop(0)}>
            <X size={14} />
          </button>
        )}
        {stack.map((crumb, index) => (
          <span className="browse-crumb-item" key={`${crumb.id}-${index}`}>
            <span className="browse-crumb-sep" aria-hidden="true">/</span>
            <button type="button" onClick={() => pop(index + 1)}>{crumb.title}</button>
          </span>
        ))}
        {stack.length > 0 ? (
          <button
            type="button"
            className="browse-crumb-refresh"
            title="Refresh"
            aria-label="Refresh"
            disabled={loading}
            onClick={() => {
              const id = stack.length > 0 ? stack[stack.length - 1].id : undefined;
              browseCache.current.delete(`${sourceId}:${id ?? "root"}`);
              setRefreshNonce((nonce) => nonce + 1);
            }}
          >
            <RefreshCw size={14} className={loading ? "spin" : undefined} />
          </button>
        ) : null}
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
            {data.items.map((item, index) => {
              // Sources (notably YouTube Music) can repeat an id across shelves, so the
              // list index is part of the key — duplicate keys make React keep stale rows.
              const itemKey = `${item.id}-${index}`;
              if (item.kind === "section") {
                return (
                  <li key={itemKey} className="browse-section">
                    {item.title}
                  </li>
                );
              }
              if (item.kind === "container") {
                // A followable podcast show (id "show:…") always shows a thumb row with a
                // follow toggle — even without art — so it can be (un)followed from any
                // list. Other art-bearing containers (albums/artists/playlists) get a
                // thumb row too; purely navigational folders (Home, New Episodes) stay a
                // plain button.
                const isFollowable = supportsPin && item.id.startsWith("show:");
                // Album containers (e.g. YouTube Music `album:…`) can be favorited.
                const isAlbumContainer = item.id.startsWith("album:");
                return (
                  <li key={itemKey}>
                    {item.albumArtUri || isFollowable ? (
                      <div className="browse-track">
                        <BrowseThumb src={item.albumArtUri} />
                        <button type="button" className="browse-drill-inline" onClick={() => drill(item)}>
                          <span>{item.title}</span>
                          {item.subtitle ? <small>{item.subtitle}</small> : null}
                        </button>
                        {isFollowable ? (
                          <button
                            type="button"
                            className={`browse-action${pinnedIds.has(item.id) ? " pinned" : ""}`}
                            title={pinnedIds.has(item.id) ? "Unfollow" : "Follow"}
                            aria-label={pinnedIds.has(item.id) ? `Unfollow ${item.title}` : `Follow ${item.title}`}
                            aria-pressed={pinnedIds.has(item.id)}
                            onClick={() => void togglePin(item)}
                          >
                            <Pin size={16} fill={pinnedIds.has(item.id) ? "currentColor" : "none"} />
                          </button>
                        ) : null}
                        {isAlbumContainer ? (
                          <button
                            type="button"
                            className={`browse-action${isFavorited(item) ? " pinned" : ""}`}
                            title={isFavorited(item) ? "Unfavorite album" : "Favorite album"}
                            aria-label={isFavorited(item) ? `Unfavorite ${item.title}` : `Favorite ${item.title}`}
                            aria-pressed={isFavorited(item)}
                            onClick={() => void toggleFavorite(item)}
                          >
                            <Heart size={16} fill={isFavorited(item) ? "currentColor" : "none"} />
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <button type="button" className="browse-drill" onClick={() => drill(item)}>
                        <span>{item.title}</span>
                        {item.subtitle ? <small>{item.subtitle}</small> : null}
                      </button>
                    )}
                  </li>
                );
              }
              const subtitle = item.kind === "album"
                ? item.subtitle
                : [item.artist, item.album].filter(Boolean).join(" · ") + (item.durationSeconds ? ` · ${formatDuration(item.durationSeconds)}` : "");
              const isAlbum = item.kind === "album";
              return (
                <li key={itemKey}>
                  <div className="browse-track">
                    <BrowseThumb src={item.albumArtUri} />
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
                        title="More actions"
                        aria-label="More actions"
                        onClick={(event) => setMenu({ item, x: event.clientX, y: event.clientY })}
                      >
                        <MoreHorizontal size={14} />
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

      {menu ? (
        <>
          <div className="action-menu-backdrop" onClick={() => setMenu(null)} onContextMenu={(event) => { event.preventDefault(); setMenu(null); }} />
          <div ref={menuRef} className="action-menu" style={{ left: menuPos?.left ?? menu.x, top: menuPos?.top ?? menu.y }} role="menu">
            <button type="button" className="action-menu-item" onClick={() => { void enqueueItem(menu.item, "next"); setMenu(null); }}>
              <ListPlus size={16} /> <span className="action-menu-item-label"><span>Play next</span></span>
            </button>
            <button type="button" className="action-menu-item" onClick={() => { void enqueueItem(menu.item, "end"); setMenu(null); }}>
              <ListEnd size={16} /> <span className="action-menu-item-label"><span>Add to end</span></span>
            </button>
            <button type="button" className="action-menu-item" onClick={() => { void toggleFavorite(menu.item); setMenu(null); }}>
              <Heart size={16} fill={isFavorited(menu.item) ? "currentColor" : "none"} />
              <span className="action-menu-item-label"><span>{isFavorited(menu.item) ? "Unfavorite" : "Favorite"}</span></span>
            </button>
            <button type="button" className="action-menu-item" onClick={() => { setAddTo(menu.item); setMenu(null); }}>
              <Plus size={16} /> <span className="action-menu-item-label"><span>Add to playlist</span></span>
            </button>
          </div>
        </>
      ) : null}

      {addTo && sourceId ? (
        <AddToPlaylistModal
          sourceId={sourceId}
          item={{ id: addTo.id, kind: addTo.kind, title: addTo.title, artist: addTo.artist, album: addTo.album, durationSeconds: addTo.durationSeconds }}
          onClose={() => setAddTo(null)}
          onDone={(message) => setStatus({ ok: true, message })}
        />
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

interface EqSliderProps {
  label: string;
  value: number;
  disabled?: boolean;
  onInput: (value: number) => void;
  onCommit: (value: number) => void;
}

function EqSlider({ label, value, disabled, onInput, onCommit }: EqSliderProps) {
  return (
    <div className="eq-slider">
      <span className="eq-slider-label">{label}</span>
      <input
        aria-label={label}
        type="range"
        min="-10"
        max="10"
        step="1"
        value={value}
        disabled={disabled}
        onChange={(event) => onInput(Number.parseInt(event.currentTarget.value, 10))}
        onPointerUp={(event) => onCommit(Number.parseInt(event.currentTarget.value, 10))}
        onKeyUp={(event) => onCommit(Number.parseInt(event.currentTarget.value, 10))}
      />
      <output>{value > 0 ? `+${value}` : value}</output>
    </div>
  );
}

interface EqualizerProps {
  zones: SonosZone[];
}

function Equalizer({ zones }: EqualizerProps) {
  const [zoneId, setZoneId] = useState<string>("");
  const [eq, setEq] = useState<EqState | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const [presets, setPresets] = useState<EqPreset[]>([]);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (zones.length === 0) { setZoneId(""); return; }
    if (!zones.some((zone) => zone.id === zoneId)) setZoneId(zones[0].id);
  }, [zones, zoneId]);

  const loadEq = useCallback(async (id: string) => {
    setState("loading");
    setError("");
    try {
      setEq(await bridgeApi.zoneEq(id));
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load EQ");
      setState("error");
    }
  }, []);

  useEffect(() => {
    if (zoneId) void loadEq(zoneId);
  }, [zoneId, loadEq]);

  const loadPresets = useCallback(async () => {
    try { setPresets(await bridgeApi.eqPresets()); } catch { /* non-fatal */ }
  }, []);
  useEffect(() => { void loadPresets(); }, [loadPresets]);

  const commit = useCallback(async (payload: EqPayload) => {
    if (!zoneId) return;
    setBusy(true);
    setError("");
    try {
      setEq(await bridgeApi.setZoneEq(zoneId, payload));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set EQ");
    } finally {
      setBusy(false);
    }
  }, [zoneId]);

  const applyPreset = useCallback((values: EqPresetValues) => {
    setEq((current) => (current ? { ...current, bass: values.bass, treble: values.treble, loudness: values.loudness } : current));
    void commit({ bass: values.bass, treble: values.treble, loudness: values.loudness });
  }, [commit]);

  const saveCurrent = useCallback(async () => {
    if (!eq || !newName.trim()) return;
    setBusy(true);
    setError("");
    try {
      await bridgeApi.createEqPreset({ name: newName.trim(), bass: eq.bass, treble: eq.treble, loudness: eq.loudness });
      setNewName("");
      await loadPresets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save preset");
    } finally {
      setBusy(false);
    }
  }, [eq, newName, loadPresets]);

  const removePreset = useCallback(async (id: number) => {
    setBusy(true);
    try {
      await bridgeApi.deleteEqPreset(id);
      await loadPresets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete preset");
    } finally {
      setBusy(false);
    }
  }, [loadPresets]);

  return (
    <section className="queue-panel" aria-label="Equalizer">
      <div className="section-heading"><h2>Equalizer</h2></div>
      {zones.length === 0 ? (
        <div className="empty-panel">No speakers found.</div>
      ) : (
        <div className="eq-panel">
          <label className="eq-zone">
            <span>Speaker</span>
            <select value={zoneId} onChange={(event) => setZoneId(event.target.value)}>
              {zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
            </select>
          </label>

          {state === "error" ? (
            <div className="empty-panel error-panel"><span>{error}</span></div>
          ) : eq ? (
            <>
              <EqSlider label="Bass" value={eq.bass} disabled={busy}
                onInput={(value) => setEq({ ...eq, bass: value })}
                onCommit={(value) => void commit({ bass: value })} />
              <EqSlider label="Treble" value={eq.treble} disabled={busy}
                onInput={(value) => setEq({ ...eq, treble: value })}
                onCommit={(value) => void commit({ treble: value })} />
              <label className="pref-row">
                <span className="pref-label">
                  <strong>Loudness</strong>
                  <small>Boost bass &amp; treble at low volume.</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={eq.loudness}
                  disabled={busy}
                  onChange={(event) => { setEq({ ...eq, loudness: event.target.checked }); void commit({ loudness: event.target.checked }); }}
                />
              </label>

              <div className="eq-presets">
                <span className="eq-presets-label">Presets</span>
                <div className="eq-chip-row">
                  {BUILT_IN_EQ_PRESETS.map((preset) => (
                    <button key={preset.name} type="button" className="eq-chip" disabled={busy} onClick={() => applyPreset(preset)}>
                      {preset.name}
                    </button>
                  ))}
                </div>
                {presets.length > 0 ? (
                  <div className="eq-chip-row">
                    {presets.map((preset) => (
                      <span key={preset.id} className="eq-chip saved">
                        <button type="button" disabled={busy} onClick={() => applyPreset(preset)}>{preset.name}</button>
                        <button type="button" className="eq-chip-remove" aria-label={`Delete ${preset.name}`} disabled={busy} onClick={() => void removePreset(preset.id)}>
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="eq-save">
                  <input
                    type="text"
                    placeholder="Save current as…"
                    value={newName}
                    maxLength={40}
                    onChange={(event) => setNewName(event.target.value)}
                  />
                  <button type="button" disabled={busy || !newName.trim()} onClick={() => void saveCurrent()}>Save</button>
                </div>
              </div>
            </>
          ) : (
            <div className="empty-panel">Loading…</div>
          )}
        </div>
      )}
    </section>
  );
}

interface SourceLogoSettingsProps {
  customIcons: Record<string, string>;
  onChanged: () => void;
}

function SourceLogoSettings({ customIcons, onChanged }: SourceLogoSettingsProps) {
  const [sources, setSources] = useState<Awaited<ReturnType<typeof bridgeApi.listSources>>>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    void bridgeApi.listSources().then(setSources).catch(() => undefined);
  }, []);

  const upload = useCallback(async (sourceId: string, file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("Please choose an image file."); return; }
    setBusyId(sourceId);
    setError("");
    try {
      await bridgeApi.uploadSourceIcon(sourceId, file);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusyId(null);
    }
  }, [onChanged]);

  const reset = useCallback(async (sourceId: string) => {
    setBusyId(sourceId);
    setError("");
    try {
      await bridgeApi.deleteSourceIcon(sourceId);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setBusyId(null);
    }
  }, [onChanged]);

  return (
    <section className="queue-panel" aria-label="Service logos">
      <div className="section-heading">
        <h2>Service logos</h2>
      </div>
      <p className="pref-hint">Upload your own logo for a music service. SVG, PNG, JPEG, WebP, or GIF up to 2 MB.</p>
      {error ? <div className="empty-panel error-panel"><span>{error}</span></div> : null}
      <ul className="logo-list">
        {sources.map((source) => {
          const hasCustom = !!customIcons[source.id];
          const busy = busyId === source.id;
          return (
            <li key={source.id} className="logo-row">
              <ServiceIcon sourceId={source.id} customVersion={customIcons[source.id]} />
              <span className="logo-name">{source.name}</span>
              <input
                ref={(element) => { inputs.current[source.id] = element; }}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif"
                hidden
                onChange={(event) => { void upload(source.id, event.target.files?.[0]); event.target.value = ""; }}
              />
              <button
                type="button"
                className="browse-action"
                title="Upload logo"
                aria-label={`Upload logo for ${source.name}`}
                disabled={busy}
                onClick={() => inputs.current[source.id]?.click()}
              >
                <Upload size={15} />
              </button>
              {hasCustom ? (
                <button
                  type="button"
                  className="browse-action"
                  title="Reset to default"
                  aria-label={`Reset ${source.name} logo`}
                  disabled={busy}
                  onClick={() => void reset(source.id)}
                >
                  <RotateCcw size={15} />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface PreferencesProps {
  showDevPanels: boolean;
  onShowDevPanelsChange: (value: boolean) => void;
  maxVolume: number;
  onMaxVolumeChange: (value: number) => void;
  onMaxVolumeCommit: (value: number) => void;
}

function Preferences({ showDevPanels, onShowDevPanelsChange, maxVolume, onMaxVolumeChange, onMaxVolumeCommit }: PreferencesProps) {
  return (
    <section className="queue-panel" aria-label="Preferences">
      <div className="section-heading">
        <h2>Preferences</h2>
      </div>
      <label className="pref-row">
        <span className="pref-label">
          <strong>Maximum volume</strong>
          <small>The volume sliders span 0–this, so the controller never goes louder.</small>
        </span>
        <span className="pref-volume">
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={maxVolume}
            aria-label="Maximum volume"
            onChange={(event) => onMaxVolumeChange(Number.parseInt(event.currentTarget.value, 10))}
            onPointerUp={(event) => onMaxVolumeCommit(Number.parseInt(event.currentTarget.value, 10))}
            onKeyUp={(event) => onMaxVolumeCommit(Number.parseInt(event.currentTarget.value, 10))}
          />
          <output>{maxVolume}</output>
        </span>
      </label>
      <label className="pref-row">
        <span className="pref-label">
          <strong>Show developer panels</strong>
          <small>Reveal the Music Services and Browse debug tools below.</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={showDevPanels}
          onChange={(event) => onShowDevPanelsChange(event.target.checked)}
        />
      </label>
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

function YouTubeMusicAuth() {
  type Status = { state: "signed-out" | "pending" | "signed-in"; verificationUrl?: string; userCode?: string; expiresAt?: number; cookieAuth?: "signed-in" | "signed-out" };
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [paste, setPaste] = useState("");
  const [showPaste, setShowPaste] = useState(false);

  const cookieSignedIn = status?.cookieAuth === "signed-in";

  const saveCookies = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const next = await bridgeApi.sourceAuthSetCookies("youtube-music", paste);
      setStatus((current) => ({ ...(current ?? { state: "signed-out" }), ...next }));
      setPaste("");
      setShowPaste(false);
      window.dispatchEvent(new CustomEvent("misonos:source-auth-changed", { detail: { sourceId: "youtube-music" } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save cookies");
    } finally {
      setBusy(false);
    }
  }, [paste]);

  const clearCookies = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const next = await bridgeApi.sourceAuthClearCookies("youtube-music");
      setStatus((current) => ({ ...(current ?? { state: "signed-out" }), ...next }));
      window.dispatchEvent(new CustomEvent("misonos:source-auth-changed", { detail: { sourceId: "youtube-music" } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't clear cookies");
    } finally {
      setBusy(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      setStatus(await bridgeApi.sourceAuthStatus("youtube-music"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read auth status");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-read status when auth changes elsewhere (e.g. the browser detected the
  // backend dropping expired cookies), so this card's label stays accurate.
  useEffect(() => {
    const onAuthChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ sourceId?: string }>).detail;
      if (!detail?.sourceId || detail.sourceId === "youtube-music") void refresh();
    };
    window.addEventListener("misonos:source-auth-changed", onAuthChanged);
    return () => window.removeEventListener("misonos:source-auth-changed", onAuthChanged);
  }, [refresh]);

  const [polling, setPolling] = useState(false);
  useEffect(() => {
    if (!polling && status?.state !== "pending") return undefined;
    const interval = window.setInterval(refresh, 2500);
    return () => window.clearInterval(interval);
  }, [polling, status?.state, refresh]);

  const prevState = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (status?.state === "signed-in") setPolling(false);
    if (prevState.current && prevState.current !== status?.state) {
      window.dispatchEvent(new CustomEvent("misonos:source-auth-changed", { detail: { sourceId: "youtube-music" } }));
    }
    prevState.current = status?.state;
  }, [status?.state]);

  const start = useCallback(async () => {
    setBusy(true);
    setError("");
    setPolling(true);
    try {
      setStatus(await bridgeApi.sourceAuthStart("youtube-music"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setStatus(await bridgeApi.sourceAuthSignOut("youtube-music"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-out failed");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <section className="settings-card">
      <h3>YouTube Music</h3>
      <p className="settings-card-help">Optional. Signed-in mode unlocks Home, Charts, New Releases, Your Library, and higher-quality streams.</p>
      {error ? <p className="settings-card-error">{error}</p> : null}
      {status?.state === "signed-in" ? (
        <div className="settings-card-row">
          <span>Signed in.</span>
          <button type="button" disabled={busy} onClick={() => void signOut()}>Sign out</button>
        </div>
      ) : status?.state === "pending" && status.verificationUrl && status.userCode ? (
        <div className="settings-card-row settings-card-column">
          <span>Open <a href={status.verificationUrl} target="_blank" rel="noreferrer">{status.verificationUrl}</a> and enter:</span>
          <strong className="settings-card-code">{status.userCode}</strong>
          <span className="settings-card-help">Status will update automatically when you finish.</span>
        </div>
      ) : (
        <div className="settings-card-row">
          <span>Not signed in. Anonymous search works without sign-in.</span>
          <button type="button" disabled={busy} onClick={() => void start()}>Sign in with Google</button>
        </div>
      )}

      <div className="settings-card-divider" />
      <h4 className="settings-card-subhead">Library &amp; Supermix (cookies)</h4>
      <p className="settings-card-help">
        Your Library and My Supermix need your YouTube&nbsp;Music cookies. On a computer, open{" "}
        <a href="https://music.youtube.com" target="_blank" rel="noreferrer">music.youtube.com</a> (signed in) →
        DevTools → <strong>Network</strong> → click any <code>/browse</code> request → right-click →
        <strong> Copy → Copy as cURL</strong>, then paste it below.
      </p>
      {cookieSignedIn ? (
        <div className="settings-card-row">
          <span>Library connected.</span>
          <button type="button" disabled={busy} onClick={() => void clearCookies()}>Disconnect</button>
        </div>
      ) : showPaste ? (
        <div className="settings-card-row settings-card-column">
          <textarea
            className="settings-card-textarea"
            value={paste}
            disabled={busy}
            placeholder="Paste the full 'Copy as cURL' here…"
            onChange={(event) => setPaste(event.target.value)}
            rows={4}
          />
          <div className="settings-card-row">
            <button type="button" disabled={busy || !paste.trim()} onClick={() => void saveCookies()}>Save cookies</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => { setShowPaste(false); setPaste(""); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="settings-card-row">
          <span>Library not connected.</span>
          <button type="button" disabled={busy} onClick={() => setShowPaste(true)}>Paste cookies</button>
        </div>
      )}
    </section>
  );
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
  onRemove: (index: number) => void;
  isFavorite: (item: QueueItem) => boolean;
  onFavorite: (item: QueueItem) => void;
}

function QueueList({ queue, activeIndex, isPlaying, onPlay, onRemove, isFavorite, onFavorite }: QueueListProps) {
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
            <button type="button" className="queue-item-main" onClick={() => onPlay(index)} aria-current={isActive ? "true" : undefined}>
              <span className="queue-indicator" aria-hidden="true">
                {isActive ? <AudioLines size={16} className={isPlaying ? "queue-indicator-active playing" : "queue-indicator-active"} /> : <span className="queue-track-number">{index + 1}</span>}
              </span>
              <BrowseThumb src={item.albumArtUri} />
              <span className="queue-meta">
                <span>{item.title}</span>
                <small>{[item.artist, item.album].filter(Boolean).join(" - ")}</small>
              </span>
            </button>
            {item.sourceId && item.trackId ? (
              <button
                type="button"
                className={`queue-action${isFavorite(item) ? " on" : ""}`}
                title={isFavorite(item) ? "Unfavorite" : "Favorite"}
                aria-label={isFavorite(item) ? `Unfavorite ${item.title}` : `Favorite ${item.title}`}
                aria-pressed={isFavorite(item)}
                onClick={() => onFavorite(item)}
              >
                <Heart size={15} fill={isFavorite(item) ? "currentColor" : "none"} />
              </button>
            ) : null}
            <button type="button" className="queue-remove" title="Remove from queue" aria-label={`Remove ${item.title} from queue`} onClick={() => onRemove(index)}>
              <X size={16} />
            </button>
          </li>
        );
      })}
    </ol>
  );
}

interface SleepTimerProps {
  remainingSeconds?: number;
  disabled: boolean;
  onSet: (seconds: number) => void;
}

const SLEEP_TIMER_OPTIONS: { label: string; seconds: number }[] = [
  { label: "Off", seconds: 0 },
  { label: "15 minutes", seconds: 15 * 60 },
  { label: "30 minutes", seconds: 30 * 60 },
  { label: "45 minutes", seconds: 45 * 60 },
  { label: "1 hour", seconds: 60 * 60 },
  { label: "2 hours", seconds: 120 * 60 }
];

function SleepTimer({ remainingSeconds, disabled, onSet }: SleepTimerProps) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const active = (remainingSeconds ?? 0) > 0;
  // Which option shows a check: the one the user picked while active, or "Off" when the
  // timer is off. (Remaining decreases, so we can't infer the original preset after the fact.)
  const checkedSeconds = picked !== null ? picked : active ? null : 0;

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Drop the remembered pick when the timer turns off (so "Off" reads as selected).
  useEffect(() => {
    if (!active) setPicked(null);
  }, [active]);

  return (
    <div className="sleep-timer" ref={ref}>
      <button
        className={`icon-button mode${active ? " active labeled" : ""}`}
        type="button"
        title={active ? `Sleep timer: ${Math.ceil((remainingSeconds ?? 0) / 60)} min left` : "Sleep timer"}
        aria-label="Sleep timer"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {active
          ? <span className="sleep-timer-label" aria-label="Minutes left">{Math.ceil((remainingSeconds ?? 0) / 60)}</span>
          : <Moon size={16} />}
      </button>
      {open ? (
        <ul className="sleep-timer-menu" role="menu">
          {SLEEP_TIMER_OPTIONS.map((option) => {
            const selected = option.seconds === checkedSeconds;
            return (
              <li key={option.seconds}>
                <button
                  type="button"
                  className={selected ? "selected" : undefined}
                  onClick={() => { setPicked(option.seconds === 0 ? 0 : option.seconds); onSet(option.seconds); setOpen(false); }}
                >
                  <span>{option.label}</span>
                  {selected ? <Check size={15} aria-hidden="true" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

interface VolumeControlProps {
  label: string;
  value: number;
  muted: boolean;
  maxVolume?: number;
  disabled?: boolean;
  onChange: (volume: number) => void;
  onMute: () => void;
  onSliderPointerDown?: () => void;
  swallowFirstAdjustment?: boolean;
}

function VolumeControl({ label, value, muted, maxVolume = 100, disabled = false, onChange, onMute, onSliderPointerDown, swallowFirstAdjustment = false }: VolumeControlProps) {
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
        max={maxVolume}
        value={Math.min(value, maxVolume)}
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

function readStoredGroupKey(): string {
  return readLocalPref(LAST_GROUP_PREF) ?? "";
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
