import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { QueueItem } from "@misonos/sonos-protocol";
import { artSrc } from "./api.js";
import { apiUrl } from "./servers.js";

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
  reorderIndex: (from: number, to: number) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  stop: () => void;
  // Lazily route the already-playing audio through Web Audio and return per-channel
  // analysers, so the VU meter can read THIS device's real output (perfectly in
  // sync, no second download). Returns null if unavailable.
  getAnalysers: () => { left: AnalyserNode; right: AnalyserNode } | null;
}

const LocalPlayerContext = createContext<LocalPlayerApi | null>(null);

function streamUrl(track: LocalTrack): string {
  // The selected backend's stream proxy resolves + serves browser-playable audio.
  return apiUrl(`/api/stream/${encodeURIComponent(track.sourceId)}/${encodeURIComponent(track.trackId)}`);
}

// A few samples of digital silence as a WAV blob URL. Playing this on an <audio>
// element inside a user gesture "unlocks" the element for later programmatic
// play() — even while the page is backgrounded — without making a sound.
let silentUrlCache: string | null = null;
function silentWavUrl(): string {
  if (silentUrlCache) return silentUrlCache;
  const sampleRate = 8000;
  const samples = 400; // ~0.05s
  const dataSize = samples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, "data"); view.setUint32(40, dataSize, true);
  // Sample bytes left as zero => silence.
  silentUrlCache = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  return silentUrlCache;
}

function sameTrack(a: LocalTrack | null | undefined, b: LocalTrack | null | undefined): boolean {
  return !!a && !!b && a.trackId === b.trackId && a.sourceId === b.sourceId;
}

// Independent in-browser audio engine. Surfaced as a Play-to target ("This device")
// that the main UI binds to like a Sonos group — but NOT synchronized with Sonos.
//
// Two <audio> elements ping-pong: while one plays track N, the other preloads
// track N+1. On track end we just play() the already-buffered, already-unlocked
// idle element instead of swapping src on one element and re-calling play() — the
// latter is what the mobile autoplay policy blocks between tracks when the screen
// is locked, leaving playback stuck.
export function LocalPlayerProvider({ children }: { children: ReactNode }) {
  const audioARef = useRef<HTMLAudioElement | null>(null);
  const audioBRef = useRef<HTMLAudioElement | null>(null);
  // Which element (0=A, 1=B) is the one currently playing; the other preloads next.
  const activeSideRef = useRef<0 | 1>(0);
  // What each side is cued to, so we know whether the idle element already holds
  // the track we're about to play (preloaded) or needs to be re-cued.
  const sideTrackRef = useRef<[LocalTrack | null, LocalTrack | null]>([null, null]);
  // Both elements unlocked for background autostart (done once, in a user gesture).
  const blessedRef = useRef(false);
  // Web Audio graph, attached lazily the first time the VU meter taps this device.
  // Both elements feed `gain` (so volume/mute keep working) and `splitter` feeds the
  // per-channel analysers; only the active element makes sound at any moment.
  const audioGraphRef = useRef<{ ctx: AudioContext; gain: GainNode; left: AnalyserNode; right: AnalyserNode } | null>(null);
  // Whether we *want* audio playing. play() can still be rejected/deferred on mobile;
  // onCanPlay retries from the active element whenever intent is set but it's paused.
  const intendPlayingRef = useRef(false);
  const [queue, setQueue] = useState<LocalTrack[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(100);
  const [muted, setMuted] = useState(false);

  const current: LocalTrack | undefined = queue[index];

  const elFor = (side: 0 | 1) => (side === 0 ? audioARef.current : audioBRef.current);
  const activeAudio = useCallback(() => elFor(activeSideRef.current), []);

  // Unlock BOTH elements for later background autostart by exercising play() on a
  // silent clip. MUST be called synchronously inside a user gesture (iOS only counts
  // the play() that happens in the gesture's own call stack, not from a later effect).
  const ensureBlessed = useCallback(() => {
    if (blessedRef.current) return;
    blessedRef.current = true;
    for (const el of [audioARef.current, audioBRef.current]) {
      if (!el) continue;
      el.muted = true;
      el.src = silentWavUrl();
      void el.play().then(() => el.pause()).catch(() => undefined);
    }
  }, []);

  // Imperatively swap the active element to `idx`. The idle element usually already
  // holds this track (preloaded), so we just play() it — buffered + unlocked, so it
  // starts even in the background. Falls back to cueing on demand for explicit jumps.
  const playTrack = useCallback((idx: number, tracks: LocalTrack[]) => {
    const track = tracks[idx];
    const toSide: 0 | 1 = activeSideRef.current === 0 ? 1 : 0;
    const toEl = elFor(toSide);
    const fromEl = activeAudio();
    if (!track || !toEl) return;
    intendPlayingRef.current = true;
    if (!sameTrack(sideTrackRef.current[toSide], track) || toEl.error) {
      toEl.src = streamUrl(track);
      sideTrackRef.current[toSide] = track;
    }
    toEl.muted = muted;
    toEl.volume = volume / 100;
    void toEl.play().catch(() => undefined);
    activeSideRef.current = toSide;
    fromEl?.pause();
    setIndex(idx);
    setPosition(0);
    setDuration(0);
  }, [muted, volume, activeAudio]);

  // Keep the idle element cued to whatever plays next, refreshed on any queue/index
  // change (advance, remove, reorder, enqueue) so the next-track handoff is instant.
  useEffect(() => {
    const idle = elFor(activeSideRef.current === 0 ? 1 : 0);
    const idleSide: 0 | 1 = activeSideRef.current === 0 ? 1 : 0;
    if (!idle) return;
    const upcoming = queue[index + 1];
    if (!upcoming) {
      if (sideTrackRef.current[idleSide]) {
        idle.removeAttribute("src");
        idle.load();
        sideTrackRef.current[idleSide] = null;
      }
      return;
    }
    if (!sameTrack(sideTrackRef.current[idleSide], upcoming)) {
      idle.muted = true; // stays silent until it becomes the active element
      idle.src = streamUrl(upcoming);
      idle.load();
      sideTrackRef.current[idleSide] = upcoming;
    }
  }, [index, queue]);

  const enqueue = useCallback((tracks: LocalTrack[], mode: "replace" | "next" | "end") => {
    if (tracks.length === 0) return;
    if (mode === "replace" || queue.length === 0) {
      ensureBlessed();
      setQueue(tracks);
      playTrack(0, tracks);
      return;
    }
    if (mode === "next") {
      setQueue((prev) => [...prev.slice(0, index + 1), ...tracks, ...prev.slice(index + 1)]);
    } else {
      setQueue((prev) => [...prev, ...tracks]);
    }
  }, [queue.length, index, ensureBlessed, playTrack]);

  const next = useCallback(() => {
    if (index + 1 < queue.length) playTrack(index + 1, queue);
    else { intendPlayingRef.current = false; activeAudio()?.pause(); setPlaying(false); }
  }, [index, queue, playTrack, activeAudio]);

  const prev = useCallback(() => {
    const audio = activeAudio();
    if (audio && audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (index > 0) playTrack(index - 1, queue);
    else if (audio) audio.currentTime = 0;
  }, [index, queue, playTrack, activeAudio]);

  const playIndex = useCallback((idx: number) => { ensureBlessed(); playTrack(idx, queue); }, [queue, ensureBlessed, playTrack]);

  const toggle = useCallback(() => {
    const audio = activeAudio();
    if (!audio || !current) return;
    if (audio.paused) { ensureBlessed(); intendPlayingRef.current = true; void audio.play().catch(() => undefined); }
    else { intendPlayingRef.current = false; audio.pause(); }
  }, [current, ensureBlessed, activeAudio]);

  const pause = useCallback(() => { intendPlayingRef.current = false; activeAudio()?.pause(); }, [activeAudio]);

  const seek = useCallback((seconds: number) => {
    const audio = activeAudio();
    if (audio && Number.isFinite(seconds)) audio.currentTime = seconds;
  }, [activeAudio]);

  // Detach both elements and forget what's cued — a hard stop, distinct from a pause.
  const haltPlayback = useCallback(() => {
    intendPlayingRef.current = false;
    for (const el of [audioARef.current, audioBRef.current]) {
      if (el) { el.pause(); el.removeAttribute("src"); el.load(); }
    }
    sideTrackRef.current = [null, null];
  }, []);

  const removeIndex = useCallback((idx: number) => {
    const nextQueue = queue.filter((_, i) => i !== idx);
    setQueue(nextQueue);
    if (idx === index) {
      // Removed the current track: play whatever shifts into its slot, else stop.
      if (idx < nextQueue.length) playTrack(idx, nextQueue);
      else { haltPlayback(); setPlaying(false); setIndex(Math.max(0, nextQueue.length - 1)); }
    } else if (idx < index) {
      setIndex((i) => i - 1);
    }
  }, [queue, index, playTrack, haltPlayback]);

  const reorderIndex = useCallback((from: number, to: number) => {
    setQueue((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    // Keep the active index pointing at the same track as it shifts.
    setIndex((cur) => {
      if (from === cur) return to;
      if (from < cur && to >= cur) return cur - 1;
      if (from > cur && to <= cur) return cur + 1;
      return cur;
    });
  }, []);

  const setVolume = useCallback((value: number) => {
    const clamped = Math.max(0, Math.min(100, value));
    setVolumeState(clamped);
    setMuted(false);
    // Apply to whichever element is currently audible; the idle element stays muted
    // until it takes over (playTrack sets its volume then).
    const audio = activeAudio();
    if (audio) { audio.volume = clamped / 100; audio.muted = false; }
    // Once the Web Audio tap is attached the element's own volume is bypassed —
    // drive output through the gain node instead.
    if (audioGraphRef.current) audioGraphRef.current.gain.gain.value = clamped / 100;
  }, [activeAudio]);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const nextMuted = !prev;
      const audio = activeAudio();
      if (audio) audio.muted = nextMuted;
      if (audioGraphRef.current) audioGraphRef.current.gain.gain.value = nextMuted ? 0 : volume / 100;
      return nextMuted;
    });
  }, [volume, activeAudio]);

  const getAnalysers = useCallback(() => {
    const a = audioARef.current;
    const b = audioBRef.current;
    if (!a || !b) return null;
    if (audioGraphRef.current) return { left: audioGraphRef.current.left, right: audioGraphRef.current.right };
    try {
      const Ctx: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const gain = ctx.createGain();
      gain.gain.value = muted ? 0 : volume / 100;
      gain.connect(ctx.destination);
      const splitter = ctx.createChannelSplitter(2);
      const left = ctx.createAnalyser();
      left.fftSize = 2048;
      left.smoothingTimeConstant = 0;
      const right = ctx.createAnalyser();
      right.fftSize = 2048;
      right.smoothingTimeConstant = 0;
      splitter.connect(left, 0);
      splitter.connect(right, 1);
      // Route BOTH ping-pong elements through the same graph; only the active one
      // produces sound, so the analysers always read whatever's currently playing.
      for (const el of [a, b]) {
        const source = ctx.createMediaElementSource(el);
        source.connect(gain);
        source.connect(splitter);
      }
      void ctx.resume();
      audioGraphRef.current = { ctx, gain, left, right };
      return { left, right };
    } catch {
      return null;
    }
  }, [muted, volume]);

  const stop = useCallback(() => {
    haltPlayback();
    setQueue([]);
    setIndex(0);
    setPlaying(false);
    setPosition(0);
    setDuration(0);
  }, [haltPlayback]);

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
    // Route art through artSrc so lock-screen artwork resolves against the selected
    // backend (and the caching /api/art proxy), not the shell host, after switching.
    const artwork = artSrc(current.albumArtUri);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: current.artist ?? "",
      album: current.album ?? "",
      artwork: artwork ? [{ src: artwork }] : []
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
    enqueue, toggle, pause, next, prev, seek, playIndex, removeIndex, reorderIndex, setVolume, toggleMute, stop, getAnalysers
  }), [queue.length, playing, nowPlaying, queueItems, index, position, duration, volume, muted,
      enqueue, toggle, pause, next, prev, seek, playIndex, removeIndex, reorderIndex, setVolume, toggleMute, stop, getAnalysers]);

  // Shared <audio> event handlers. Events fire on both elements (incl. the silent
  // blessing clip and the preloading idle element); we only act on the active one.
  const isActive = (el: HTMLAudioElement) => el === activeAudio();
  const isSilent = (el: HTMLAudioElement) => el.src === silentUrlCache;

  return (
    <LocalPlayerContext.Provider value={api}>
      {children}
      {([audioARef, audioBRef] as const).map((ref, i) => (
        <audio
          key={i}
          ref={ref}
          // CORS-enable the element so the VU meter's Web Audio graph
          // (createMediaElementSource) can read the stream — and doesn't mute it — when
          // the controller is pointed at another location's (cross-origin) backend. The
          // stream proxy answers with Access-Control-Allow-Origin: * to match.
          crossOrigin="anonymous"
          preload="auto"
          onPlay={(e) => { if (isActive(e.currentTarget) && !isSilent(e.currentTarget)) setPlaying(true); }}
          onPause={(e) => { if (isActive(e.currentTarget) && !isSilent(e.currentTarget)) setPlaying(false); }}
          onPlaying={(e) => { if (isActive(e.currentTarget) && !isSilent(e.currentTarget)) setPlaying(true); }}
          // The active element's stream is ready but its autostart play() was rejected
          // (mobile autoplay policy / backgrounded). Retry — this unsticks transitions.
          onCanPlay={(e) => { if (intendPlayingRef.current && isActive(e.currentTarget) && e.currentTarget.paused) void e.currentTarget.play().catch(() => undefined); }}
          // A stream that failed to load on the active element would dead-end the
          // queue; skip past it. Errors on the idle/silent element are ignored.
          onError={(e) => { if (intendPlayingRef.current && isActive(e.currentTarget) && !isSilent(e.currentTarget)) next(); }}
          onTimeUpdate={(e) => { if (isActive(e.currentTarget)) setPosition(e.currentTarget.currentTime); }}
          onDurationChange={(e) => { if (isActive(e.currentTarget)) setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0); }}
          onEnded={(e) => { if (isActive(e.currentTarget)) next(); }}
        />
      ))}
    </LocalPlayerContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useLocalPlayer(): LocalPlayerApi {
  const ctx = useContext(LocalPlayerContext);
  if (!ctx) throw new Error("useLocalPlayer must be used within a LocalPlayerProvider");
  return ctx;
}
