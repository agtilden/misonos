import { describe, expect, it } from "vitest";
import { mp3Bitrate, nearestMp3Bitrate } from "../src/mp3.js";

// MPEG-1 Layer III, no CRC, 48 kHz; the bitrate index is the high nibble of byte 3.
const frame = (index: number) => [0xff, 0xfb, (index << 4) | 0x04, 0x00];

function id3(bodySize: number): number[] {
  const syncsafe = [(bodySize >> 21) & 0x7f, (bodySize >> 14) & 0x7f, (bodySize >> 7) & 0x7f, bodySize & 0x7f];
  return [0x49, 0x44, 0x33, 4, 0, 0, ...syncsafe, ...new Array<number>(bodySize).fill(0xff)];
}

describe("mp3Bitrate", () => {
  it("reads the bitrate of the first frame", () => {
    expect(mp3Bitrate(Uint8Array.from(frame(14)))).toBe(320);
    expect(mp3Bitrate(Uint8Array.from(frame(9)))).toBe(128);
  });

  it("skips a leading ID3v2 tag, even one full of 0xFF", () => {
    expect(mp3Bitrate(Uint8Array.from([...id3(300), ...frame(13)]))).toBe(256);
  });

  it("waits for more data when the tag or frame isn't complete yet", () => {
    expect(mp3Bitrate(Uint8Array.from(id3(300).slice(0, 200)))).toBeUndefined();
    expect(mp3Bitrate(Uint8Array.from([...id3(300), 0xff, 0xfb]))).toBeUndefined();
  });

  it("uses the MPEG-2 table for MPEG-2 frames and ignores non-MP3 data", () => {
    expect(mp3Bitrate(Uint8Array.from([0xff, 0xf3, 0x84, 0x00]))).toBe(64);
    expect(mp3Bitrate(new TextEncoder().encode("OggS not an mp3"))).toBeUndefined();
  });
});

describe("nearestMp3Bitrate", () => {
  it("snaps to a real MP3 bitrate the way LAME does", () => {
    expect(nearestMp3Bitrate(320)).toBe(320);
    expect(nearestMp3Bitrate(312)).toBe(320);
    expect(nearestMp3Bitrate(130)).toBe(128);
    expect(nearestMp3Bitrate(288)).toBe(256); // a tie goes down
    expect(nearestMp3Bitrate(500)).toBe(320);
    expect(nearestMp3Bitrate(8)).toBe(32);
  });
});
