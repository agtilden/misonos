import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { QueueItem } from "@misonos/sonos-protocol";

export interface LocalTrack {
  sourceId: string;
  trackId: string;
  title: string;
  artist?: string;
  album?: string;
  albumArtUri?: string;
}

export interface LocalNowPlaying {
  state: "PLAYING" | "PAUSED_PLAYBACK";
  title: string;
  artist?: string;
  album?: string;
  albumArtUri?: string;
}

interface LocalPlayerApi {
  active: boolean;
  playing: boolean;
  nowPlaying: LocalNowPlaying | null;
  queue: QueueItem[];
  activeIndex: number;
  position: number;
  duration: number;
  volume: number; // 0..100
  muted: boolean;
  enqueue: (tracks: LocalTrack[], mode: "replace" | "next" | "end") => void;
  toggle: () => void;
  pause: () => void;
  next: () => void;
  prev: () => void;
  seek: (seconds: number) => void;
  playIndex: (index: number) => void;
  removeIndex: (index: number) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  stop: () => void;
}

const LocalPlayerContext = createContext<LocalPlayerApi | null>(null);

function streamUrl(track: LocalTrack): string {
  // Same-origin; the bridge stream proxy resolves + serves browser-playable audio.
  return `/api/stream/${encodeURIComponent(track.sourceId)}/${encodeURIComponent(track.trackId)}`;
}

// Independent in-browser audio engine. Surfaced as a Play-to target ("This device")
// that the main UI binds to like a Sonos group — but NOT synchronized with Sonos.
export function LocalPlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [queue, setQueue] = useState<LocalTrack[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(100);
  const [muted, setMuted] = useState(false);

  const current: LocalTrack | undefined = queue[index];

  // Imperatively load + play so the first play stays within the click's user gesture.
  const loadAndPlay = useCallback((idx: number, tracks: LocalTrack[]) => {
    const audio = audioRef.current;
    const track = tracks[idx];
    if (!audio || !track) return;
    setIndex(idx);
    setPosition(0);
    setDuration(0);
    audio.src = streamUrl(track);
    void audio.play().catch(() => undefined);
  }, []);

  const enqueue = useCallback((tracks: LocalTrack[], mode: "replace" | "next" | "end") => {
    if (tracks.length === 0) return;
    if (mode === "replace" || queue.length === 0) {
      setQueue(tracks);
      loadAndPlay(0, tracks);
      return;
    }
    if (mode === "next") {
      setQueue((prev) => [...prev.slice(0, index + 1), ...tracks, ...prev.slice(index + 1)]);
    } else {
      setQueue((prev) => [...prev, ...tracks]);
    }
  }, [queue.length, index, loadAndPlay]);

  const next = useCallback(() => {
    if (index + 1 < queue.length) loadAndPlay(index + 1, queue);
    else { audioRef.current?.pause(); setPlaying(false); }
  }, [index, queue, loadAndPlay]);

  const prev = useCallback(() => {
    const audio = audioRef.current;
    if (audio && audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (index > 0) loadAndPlay(index - 1, queue);
    else if (audio) audio.currentTime = 0;
  }, [index, queue, loadAndPlay]);

  const playIndex = useCallback((idx: number) => loadAndPlay(idx, queue), [queue, loadAndPlay]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    if (audio.paused) void audio.play().catch(() => undefined);
    else audio.pause();
  }, [current]);

  const pause = useCallback(() => { audioRef.current?.pause(); }, []);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (audio && Number.isFinite(seconds)) audio.currentTime = seconds;
  }, []);

  const removeIndex = useCallback((idx: number) => {
    const nextQueue = queue.filter((_, i) => i !== idx);
    setQueue(nextQueue);
    if (idx === index) {
      // Removed the current track: play whatever shifts into its slot, else stop.
      if (idx < nextQueue.length) loadAndPlay(idx, nextQueue);
      else { audioRef.current?.pause(); setPlaying(false); setIndex(Math.max(0, nextQueue.length - 1)); }
    } else if (idx < index) {
      setIndex((i) => i - 1);
    }
  }, [queue, index, loadAndPlay]);

  const setVolume = useCallback((value: number) => {
    const clamped = Math.max(0, Math.min(100, value));
    setVolumeState(clamped);
    setMuted(false);
    const audio = audioRef.current;
    if (audio) { audio.volume = clamped / 100; audio.muted = false; }
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const nextMuted = !prev;
      if (audioRef.current) audioRef.current.muted = nextMuted;
      return nextMuted;
    });
  }, []);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.removeAttribute("src"); audio.load(); }
    setQueue([]);
    setIndex(0);
    setPlaying(false);
    setPosition(0);
    setDuration(0);
  }, []);

  // Derived, UI-facing shapes.
  const nowPlaying = useMemo<LocalNowPlaying | null>(() => current ? {
    state: playing ? "PLAYING" : "PAUSED_PLAYBACK",
    title: current.title,
    artist: current.artist,
    album: current.album,
    albumArtUri: current.albumArtUri
  } : null, [current, playing]);

  const queueItems = useMemo<QueueItem[]>(() => queue.map((track, i) => ({
    id: `${track.trackId}-${i}`,
    title: track.title,
    artist: track.artist,
    album: track.album,
    albumArtUri: track.albumArtUri,
    sourceId: track.sourceId,
    trackId: track.trackId
  })), [queue]);

  // MediaSession: lock-screen / notification metadata + transport controls.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    if (!current) { navigator.mediaSession.metadata = null; return; }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: current.artist ?? "",
      album: current.album ?? "",
      artwork: current.albumArtUri ? [{ src: current.albumArtUri }] : []
    });
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    navigator.mediaSession.setActionHandler("play", () => toggle());
    navigator.mediaSession.setActionHandler("pause", () => toggle());
    navigator.mediaSession.setActionHandler("nexttrack", () => next());
    navigator.mediaSession.setActionHandler("previoustrack", () => prev());
    navigator.mediaSession.setActionHandler("seekto", (details) => { if (typeof details.seekTime === "number") seek(details.seekTime); });
  }, [current, playing, toggle, next, prev, seek]);

  const api = useMemo<LocalPlayerApi>(() => ({
    active: queue.length > 0,
    playing, nowPlaying, queue: queueItems, activeIndex: index, position, duration, volume, muted,
    enqueue, toggle, pause, next, prev, seek, playIndex, removeIndex, setVolume, toggleMute, stop
  }), [queue.length, playing, nowPlaying, queueItems, index, position, duration, volume, muted,
      enqueue, toggle, pause, next, prev, seek, playIndex, removeIndex, setVolume, toggleMute, stop]);

  return (
    <LocalPlayerContext.Provider value={api}>
      {children}
      <audio
        ref={audioRef}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onPlaying={() => setPlaying(true)}
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onDurationChange={(e) => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
        onEnded={() => next()}
      />
    </LocalPlayerContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useLocalPlayer(): LocalPlayerApi {
  const ctx = useContext(LocalPlayerContext);
  if (!ctx) throw new Error("useLocalPlayer must be used within a LocalPlayerProvider");
  return ctx;
}
