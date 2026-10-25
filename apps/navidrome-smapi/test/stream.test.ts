import { describe, expect, it } from "vitest";
import { needsTranscode, streamMime } from "../src/formats.js";
import { planStream, rangeStart } from "../src/stream.js";

const MP3_320 = { transcodeFormat: "mp3", maxBitRate: 320 };

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

  it("transcodes Opus from the start when there is no Range", () => {
    const plan = planStream({ id: "s2", suffix: "opus", duration: 200 }, MP3_320);
    expect(plan.params).toMatchObject({ id: "s2", format: "mp3", maxBitRate: 320, estimateContentLength: true });
    expect(plan.params.timeOffset).toBeUndefined();
    expect(plan.forwardRange).toBe(false);
    expect(plan.partial).toBeUndefined();
  });

  it("maps a byte Range on a CBR transcode to a time offset", () => {
    // 320 kbps = 40000 bytes/s, so byte 4_000_000 is 100 s in.
    const plan = planStream({ id: "s3", suffix: "opus", duration: 200 }, MP3_320, "bytes=4000000-");
    expect(plan.params.timeOffset).toBe(100);
    expect(plan.partial).toEqual({ start: 4_000_000, total: 8_000_000 });
  });

  it("ignores ranges it can't map", () => {
    expect(planStream({ id: "s4", suffix: "opus", duration: 200 }, MP3_320, "bytes=0-").partial).toBeUndefined();
    expect(planStream({ id: "s4", suffix: "opus", duration: 200 }, MP3_320, "bytes=9000000-").partial).toBeUndefined();
    expect(planStream({ id: "s4", suffix: "opus" }, MP3_320, "bytes=4000000-").partial).toBeUndefined();
    expect(planStream({ id: "s4", suffix: "opus", duration: 200 }, { transcodeFormat: "flac", maxBitRate: 0 }, "bytes=4000000-").partial).toBeUndefined();
  });

  it("parses only simple single ranges", () => {
    expect(rangeStart("bytes=10-")).toBe(10);
    expect(rangeStart("bytes=10-20")).toBe(10);
    expect(rangeStart("bytes=-500")).toBeUndefined();
    expect(rangeStart("bytes=1-2,5-6")).toBeUndefined();
    expect(rangeStart(undefined)).toBeUndefined();
  });
});
