import { describe, expect, it } from "vitest";
import { needsTranscode, streamMime } from "../src/formats.js";
import { exactly, parseRange, planStream, transcodeBitrate } from "../src/stream.js";

const MP3_320 = { transcodeFormat: "mp3", maxBitRate: 320 };
// 200 s at 320 kbps (40000 bytes/s), plus one second of slack and the 16 KiB tag allowance.
const TOTAL_320 = 201 * 40_000 + 16 * 1024;

describe("formats", () => {
  it("passes Sonos-native files through and transcodes the rest", () => {
    expect(needsTranscode({ suffix: "mp3" })).toBe(false);
    expect(needsTranscode({ suffix: "FLAC" })).toBe(false);
    expect(needsTranscode({ suffix: "opus" })).toBe(true);
    expect(needsTranscode({ suffix: "ogg" })).toBe(true);
    expect(needsTranscode({})).toBe(true);
  });

  it("reports the mime the speaker will actually receive", () => {
    expect(streamMime({ suffix: "opus", contentType: "audio/ogg" }, "mp3")).toBe("audio/mpeg");
    expect(streamMime({ suffix: "flac", contentType: "audio/x-flac" }, "mp3")).toBe("audio/flac");
    expect(streamMime({ suffix: "m4a" }, "mp3")).toBe("audio/mp4");
  });
});

describe("planStream", () => {
  it("streams native files raw and forwards the client's Range", () => {
    const plan = planStream({ id: "s1", suffix: "mp3", duration: 200 }, MP3_320, "bytes=1000-");
    expect(plan).toEqual({ params: { id: "s1", format: "raw" }, forwardRange: true });
  });

  it("sizes an Opus transcode from the start when there is no Range", () => {
    const plan = planStream({ id: "s2", suffix: "opus", duration: 200, bitRate: 330 }, MP3_320);
    expect(plan.params).toEqual({ id: "s2", format: "mp3", maxBitRate: 320 });
    expect(plan.forwardRange).toBe(false);
    expect(plan.sized).toEqual({ status: 200, start: 0, end: TOTAL_320 - 1, total: TOTAL_320, kbps: 320 });
  });

  it("maps a byte Range on a CBR transcode to a time offset", () => {
    // 320 kbps = 40000 bytes/s, so byte 4_000_000 is 100 s in.
    const plan = planStream({ id: "s3", suffix: "opus", duration: 200 }, MP3_320, "bytes=4000000-");
    expect(plan.params.timeOffset).toBe(100);
    expect(plan.sized).toEqual({ status: 206, start: 4_000_000, end: TOTAL_320 - 1, total: TOTAL_320, kbps: 320 });
  });

  it("keeps a closed range's end and doesn't offset a range inside the first second", () => {
    const plan = planStream({ id: "s3", suffix: "opus", duration: 200 }, MP3_320, "bytes=0-1");
    expect(plan.params.timeOffset).toBeUndefined();
    expect(plan.sized).toMatchObject({ status: 206, start: 0, end: 1 });
  });

  it("uses the bitrate the server will really transcode at", () => {
    // A 130 kbps Opus file comes out as 128 kbps MP3: 16000 bytes/s.
    const plan = planStream({ id: "s5", suffix: "opus", duration: 200, bitRate: 130 }, MP3_320, "bytes=1600000-");
    expect(plan.params.timeOffset).toBe(100);
    expect(plan.sized).toMatchObject({ kbps: 128, total: 201 * 16_000 + 16 * 1024 });
    // A bitrate read off an earlier response wins over the prediction.
    expect(planStream({ id: "s5", suffix: "opus", duration: 200, bitRate: 130 }, { ...MP3_320, kbps: 320 }).sized?.kbps).toBe(320);
  });

  it("answers a range past the end as unsatisfiable", () => {
    const plan = planStream({ id: "s4", suffix: "opus", duration: 200 }, MP3_320, `bytes=${TOTAL_320}-`);
    expect(plan.sized).toEqual({ status: 416, total: TOTAL_320, kbps: 320 });
  });

  it("leaves transcodes it can't size unsized", () => {
    expect(planStream({ id: "s4", suffix: "opus" }, MP3_320, "bytes=4000000-").sized).toBeUndefined();
    expect(planStream({ id: "s4", suffix: "opus", duration: 200 }, { transcodeFormat: "flac", maxBitRate: 0 }).sized).toBeUndefined();
    expect(planStream({ id: "s4", suffix: "opus", duration: 200 }, { transcodeFormat: "mp3", maxBitRate: 0 }).sized).toBeUndefined();
  });
});

describe("transcodeBitrate", () => {
  it("caps at maxBitRate and snaps to an MP3 bitrate", () => {
    expect(transcodeBitrate({ bitRate: 312 }, 320)).toBe(320);
    expect(transcodeBitrate({ bitRate: 900 }, 320)).toBe(320);
    expect(transcodeBitrate({ bitRate: 160 }, 320)).toBe(160);
    expect(transcodeBitrate({ bitRate: 300 }, 192)).toBe(192);
    expect(transcodeBitrate({}, 320)).toBe(320);
  });
});

describe("parseRange", () => {
  it("parses only simple single ranges", () => {
    expect(parseRange("bytes=10-")).toEqual({ start: 10, end: undefined });
    expect(parseRange("bytes=10-20")).toEqual({ start: 10, end: 20 });
    expect(parseRange("bytes=20-10")).toBeUndefined();
    expect(parseRange("bytes=-500")).toBeUndefined();
    expect(parseRange("bytes=1-2,5-6")).toBeUndefined();
    expect(parseRange(undefined)).toBeUndefined();
  });
});

describe("exactly", () => {
  async function collect(chunks: number[][], length: number): Promise<number[]> {
    async function* source() {
      for (const chunk of chunks) yield Uint8Array.from(chunk);
    }
    const out: number[] = [];
    for await (const chunk of exactly(source(), length)) out.push(...chunk);
    return out;
  }

  it("cuts the stream off at the length and stops reading", async () => {
    let reads = 0;
    async function* source() {
      for (;;) {
        reads += 1;
        yield Uint8Array.from([1, 2, 3]);
      }
    }
    const out: number[] = [];
    for await (const chunk of exactly(source(), 7)) out.push(...chunk);
    expect(out).toEqual([1, 2, 3, 1, 2, 3, 1]);
    expect(reads).toBe(3);
  });

  it("pads a short stream with zeros", async () => {
    expect(await collect([[1, 2], [3]], 6)).toEqual([1, 2, 3, 0, 0, 0]);
  });

  it("passes an exact-length stream through", async () => {
    expect(await collect([[1, 2], [3]], 3)).toEqual([1, 2, 3]);
  });
});
