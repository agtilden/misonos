import { needsTranscode } from "./formats.js";
import type { SubsonicSong } from "./subsonic.js";

export interface StreamPlan {
  // Query params for the Subsonic `stream` call (auth is added by the client).
  params: Record<string, string | number | boolean | undefined>;
  // Raw files serve byte ranges themselves, so the request's Range is forwarded.
  forwardRange: boolean;
  // A byte Range on a transcoded stream, answered by starting the transcode at
  // the matching time offset and labelling the result as that byte range.
  partial?: { start: number; total: number };
}

// Transcoded output has no real byte offsets, but Sonos seeks with Range requests.
// For constant-bitrate MP3, bytes map linearly to time, so a Range start becomes a
// `timeOffset` and the response claims the requested range of an estimated total.
export function planStream(
  song: Pick<SubsonicSong, "id" | "suffix" | "duration">,
  options: { transcodeFormat: string; maxBitRate: number },
  rangeHeader?: string
): StreamPlan {
  if (!needsTranscode(song)) return { params: { id: song.id, format: "raw" }, forwardRange: true };

  const params = {
    id: song.id,
    format: options.transcodeFormat,
    maxBitRate: options.maxBitRate,
    estimateContentLength: true
  };
  const constantBitRate = options.transcodeFormat === "mp3" && options.maxBitRate > 0;
  const start = rangeStart(rangeHeader);
  if (!constantBitRate || !start || !song.duration) return { params, forwardRange: false };

  const bytesPerSecond = options.maxBitRate * 125; // kbit/s → bytes/s
  const total = Math.ceil(song.duration * bytesPerSecond);
  if (start >= total) return { params, forwardRange: false };
  return {
    params: { ...params, timeOffset: Math.floor(start / bytesPerSecond) },
    forwardRange: false,
    partial: { start, total }
  };
}

// The start of a single "bytes=N-" / "bytes=N-M" range; undefined for anything else.
export function rangeStart(header: string | undefined): number | undefined {
  const match = header?.match(/^bytes=(\d+)-\d*$/);
  if (!match) return undefined;
  const start = Number.parseInt(match[1], 10);
  return Number.isFinite(start) ? start : undefined;
}
