import type { SubsonicSong } from "./subsonic.js";

// File types Sonos decodes natively, by suffix. Everything else is transcoded by
// the server on the fly — Opus above all, and Ogg too, since an .ogg may hold Opus.
const SONOS_NATIVE = new Map<string, string>([
  ["mp3", "audio/mpeg"],
  ["flac", "audio/flac"],
  ["m4a", "audio/mp4"],
  ["mp4", "audio/mp4"],
  ["aac", "audio/aac"],
  ["wav", "audio/wav"],
  ["aif", "audio/aiff"],
  ["aiff", "audio/aiff"]
]);

const TRANSCODE_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  flac: "audio/flac",
  aac: "audio/aac"
};

export function needsTranscode(song: Pick<SubsonicSong, "suffix">): boolean {
  return !SONOS_NATIVE.has((song.suffix ?? "").toLowerCase());
}

export function streamMime(song: Pick<SubsonicSong, "suffix" | "contentType">, transcodeFormat: string): string {
  if (needsTranscode(song)) return TRANSCODE_MIME[transcodeFormat] ?? "audio/mpeg";
  return SONOS_NATIVE.get((song.suffix ?? "").toLowerCase()) ?? song.contentType ?? "audio/mpeg";
}
