import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import type http from "node:http";

// Server-side VU metering. The stream proxy already pulls the exact bytes a speaker
// is playing, so we tee that single stream into ffmpeg (decode → raw PCM), compute
// per-window L/R RMS + peak, store them time-indexed, and stream them to the web VU
// meter over SSE. No second download competes with the speaker (which was what made
// a browser-side analyzer stutter), and the client aligns windows to the speaker's
// playback position. Metered per (sourceId, trackId); only the first proxied
// request for a track is decoded.

const SAMPLE_RATE = 8000; // plenty for level metering; keeps CPU + bytes low
const CHANNELS = 2;
const WINDOW_MS = 40; // 25 Hz level updates; the VU ballistics smooth the rest
const WINDOW_SAMPLES = Math.round((SAMPLE_RATE * WINDOW_MS) / 1000);
const FRAME_BYTES = CHANNELS * 4; // f32le interleaved
const WINDOW_BYTES = WINDOW_SAMPLES * FRAME_BYTES;
const MAX_STREAMS = 4; // LRU cap on concurrently-metered tracks

type Window = [lr: number, rr: number, lp: number, rp: number];

interface MeterStream {
  ff: ChildProcessWithoutNullStreams | null;
  windows: Window[];
  subscribers: Set<http.ServerResponse>;
  leftover: Buffer;
  lastTouched: number;
}

const streams = new Map<string, MeterStream>();
let ffmpegOk = true;

const keyOf = (sourceId: string, trackId: string) => `${sourceId}\n${trackId}`;

export const meterWindowMs = WINDOW_MS;

// Tee a proxied audio byte stream into ffmpeg and accumulate level windows.
// `range` lets us meter only a from-the-start request so window index == track time.
export function meterStream(sourceId: string, trackId: string, bytes: Readable, range: string | undefined): void {
  if (!ffmpegOk) return;
  if (range && !/^bytes=0-/.test(range)) return; // only decode a from-start fetch
  const key = keyOf(sourceId, trackId);
  if (streams.has(key)) { streams.get(key)!.lastTouched = Date.now(); return; }

  let ff: ChildProcessWithoutNullStreams;
  try {
    ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", String(CHANNELS), "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1"]);
  } catch {
    ffmpegOk = false;
    return;
  }
  evictIfNeeded();
  const stream: MeterStream = { ff, windows: [], subscribers: new Set(), leftover: Buffer.alloc(0), lastTouched: Date.now() };
  streams.set(key, stream);

  ff.on("error", () => { ffmpegOk = false; dropStream(key); });
  ff.stdout.on("data", (chunk: Buffer) => consumePcm(stream, chunk));
  // Forward the proxied bytes into ffmpeg without applying backpressure to the
  // speaker's stream (ffmpeg keeps up; if its stdin is gone, just stop feeding).
  const feed = (chunk: Buffer) => { if (ff.stdin.writable) ff.stdin.write(chunk); };
  bytes.on("data", feed);
  bytes.on("end", () => { if (ff.stdin.writable) ff.stdin.end(); });
  bytes.on("error", () => { if (ff.stdin.writable) ff.stdin.end(); });
}

function consumePcm(stream: MeterStream, chunk: Buffer): void {
  const buf = stream.leftover.length ? Buffer.concat([stream.leftover, chunk]) : chunk;
  let off = 0;
  while (buf.length - off >= WINDOW_BYTES) {
    let lSum = 0, rSum = 0, lPeak = 0, rPeak = 0;
    for (let s = 0; s < WINDOW_SAMPLES; s++) {
      const base = off + s * FRAME_BYTES;
      const l = buf.readFloatLE(base);
      const r = buf.readFloatLE(base + 4);
      lSum += l * l; rSum += r * r;
      const la = l < 0 ? -l : l;
      const ra = r < 0 ? -r : r;
      if (la > lPeak) lPeak = la;
      if (ra > rPeak) rPeak = ra;
    }
    const w: Window = [round(Math.sqrt(lSum / WINDOW_SAMPLES)), round(Math.sqrt(rSum / WINDOW_SAMPLES)), round(lPeak), round(rPeak)];
    stream.windows.push(w);
    if (stream.subscribers.size > 0) {
      const line = `event: w\ndata: ${w.join(",")}\n\n`;
      for (const res of stream.subscribers) res.write(line);
    }
    off += WINDOW_BYTES;
  }
  stream.leftover = off > 0 ? buf.subarray(off) : buf;
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

// Attach an SSE subscriber: replay the windows decoded so far, then stream new ones.
export function subscribeMeter(sourceId: string, trackId: string, res: http.ServerResponse): void {
  const key = keyOf(sourceId, trackId);
  let stream = streams.get(key);
  if (!stream) {
    // No proxied stream yet (the speaker may not have started fetching) — hold the
    // connection open so windows flow once metering begins.
    stream = { ff: null, windows: [], subscribers: new Set(), leftover: Buffer.alloc(0), lastTouched: Date.now() };
    streams.set(key, stream);
  }
  stream.subscribers.add(res);
  stream.lastTouched = Date.now();
  res.write(`event: init\ndata: ${JSON.stringify({ windowMs: WINDOW_MS, windows: stream.windows })}\n\n`);
  res.on("close", () => { stream!.subscribers.delete(res); });
}

function dropStream(key: string): void {
  const s = streams.get(key);
  if (!s) return;
  s.ff?.kill("SIGKILL");
  for (const res of s.subscribers) { try { res.end(); } catch { /* ignore */ } }
  streams.delete(key);
}

function evictIfNeeded(): void {
  while (streams.size >= MAX_STREAMS) {
    let oldestKey: string | undefined;
    let oldest = Infinity;
    for (const [k, s] of streams) {
      if (s.subscribers.size === 0 && s.lastTouched < oldest) { oldest = s.lastTouched; oldestKey = k; }
    }
    if (!oldestKey) break;
    dropStream(oldestKey);
  }
}
