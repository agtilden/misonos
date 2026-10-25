import { needsTranscode } from "./formats.js";
import { nearestMp3Bitrate } from "./mp3.js";
import type { SubsonicSong } from "./subsonic.js";

// Room for the ID3 tag the transcoder writes ahead of the audio (title, artist, …).
const TAG_ALLOWANCE = 16 * 1024;
const PAD_CHUNK = 64 * 1024;

// The byte layout this service gives a sized transcode response.
export type SizedResponse =
  | { status: 200 | 206; start: number; end: number; total: number; kbps: number }
  | { status: 416; total: number; kbps: number };

export interface StreamPlan {
  // Query params for the Subsonic `stream` call (auth is added by the client).
  params: Record<string, string | number | boolean | undefined>;
  // Raw files serve byte ranges themselves, so the request's Range is forwarded.
  forwardRange: boolean;
  // Set for constant-bitrate MP3 transcodes, which this service sizes itself.
  sized?: SizedResponse;
}

// Sonos wants a length and seeks with Range requests, but a transcode has neither
// until it's finished. For constant-bitrate MP3, bytes map linearly to time, so the
// response claims an estimated total (padded to fit, see `exactly`) and a Range
// start becomes a `timeOffset` on the transcode.
export function planStream(
  song: Pick<SubsonicSong, "id" | "suffix" | "duration" | "bitRate">,
  options: { transcodeFormat: string; maxBitRate: number; kbps?: number },
  rangeHeader?: string
): StreamPlan {
  if (!needsTranscode(song)) return { params: { id: song.id, format: "raw" }, forwardRange: true };

  const params = { id: song.id, format: options.transcodeFormat, maxBitRate: options.maxBitRate };
  if (options.transcodeFormat !== "mp3" || options.maxBitRate <= 0 || !song.duration) {
    return { params, forwardRange: false };
  }

  const kbps = options.kbps ?? transcodeBitrate(song, options.maxBitRate);
  const bytesPerSecond = kbps * 125; // kbit/s → bytes/s
  // Subsonic durations are whole seconds (Navidrome rounds down): allow one more.
  const total = (Math.floor(song.duration) + 1) * bytesPerSecond + TAG_ALLOWANCE;
  const range = parseRange(rangeHeader);
  if (!range) return { params, forwardRange: false, sized: { status: 200, start: 0, end: total - 1, total, kbps } };
  if (range.start >= total) return { params, forwardRange: false, sized: { status: 416, total, kbps } };

  const timeOffset = Math.floor(range.start / bytesPerSecond);
  return {
    params: timeOffset > 0 ? { ...params, timeOffset } : params,
    forwardRange: false,
    sized: { status: 206, start: range.start, end: Math.min(range.end ?? total - 1, total - 1), total, kbps }
  };
}

// Navidrome transcodes a lossy file at min(its bitrate, maxBitRate), and LAME rounds
// that to a real MP3 bitrate. The first frame of the transcode confirms it.
export function transcodeBitrate(song: Pick<SubsonicSong, "bitRate">, maxBitRate: number): number {
  const requested = song.bitRate && song.bitRate > 0 ? Math.min(song.bitRate, maxBitRate) : maxBitRate;
  return nearestMp3Bitrate(requested);
}

// A single "bytes=N-" / "bytes=N-M" range; undefined for anything else.
export function parseRange(header: string | undefined): { start: number; end?: number } | undefined {
  const match = header?.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : undefined;
  if (!Number.isSafeInteger(start)) return undefined;
  if (end !== undefined && (!Number.isSafeInteger(end) || end < start)) return undefined;
  return { start, end };
}

// Exactly `length` bytes of `chunks`: cut off once there are enough (which stops the
// read), or padded with zeros when the transcode ends short. MP3 decoders skip the
// padding as non-audio.
export async function* exactly(chunks: AsyncIterable<Uint8Array>, length: number): AsyncGenerator<Uint8Array> {
  let remaining = length;
  for await (const chunk of chunks) {
    if (chunk.length >= remaining) {
      yield chunk.subarray(0, remaining);
      return;
    }
    remaining -= chunk.length;
    yield chunk;
  }
  while (remaining > 0) {
    const size = Math.min(remaining, PAD_CHUNK);
    remaining -= size;
    yield new Uint8Array(size);
  }
}
