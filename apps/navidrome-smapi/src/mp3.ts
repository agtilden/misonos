// Just enough MPEG audio parsing to read a CBR transcode's bitrate from its first frame.

// Layer III bitrates (kbps) by header index, for MPEG-1 and for MPEG-2/2.5.
const MPEG1_LAYER3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_LAYER3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

// The bitrate of the first Layer III frame in `data`, after any leading ID3v2 tag;
// undefined when `data` doesn't reach a frame yet, or isn't MP3.
export function mp3Bitrate(data: Uint8Array): number | undefined {
  let offset = 0;
  if (data.length >= 10 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {
    // "ID3": a 10-byte header whose size is a 28-bit syncsafe integer, plus an optional footer.
    const size = ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f);
    offset = 10 + size + (data[5] & 0x10 ? 10 : 0);
  }
  for (let i = offset; i + 2 < data.length; i++) {
    if (data[i] !== 0xff || (data[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (data[i + 1] >> 3) & 0x03; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    const layer = (data[i + 1] >> 1) & 0x03; // 1 = Layer III
    const index = data[i + 2] >> 4;
    const sampleRate = (data[i + 2] >> 2) & 0x03;
    if (version === 1 || layer !== 1 || index === 0 || index === 15 || sampleRate === 3) continue;
    return (version === 3 ? MPEG1_LAYER3_KBPS : MPEG2_LAYER3_KBPS)[index];
  }
  return undefined;
}

// The bitrate LAME actually encodes when asked for `kbps` at CBR: the nearest
// MPEG-1 Layer III rate, ties going down.
export function nearestMp3Bitrate(kbps: number): number {
  let best = MPEG1_LAYER3_KBPS[1];
  for (const rate of MPEG1_LAYER3_KBPS.slice(2)) {
    if (Math.abs(rate - kbps) < Math.abs(best - kbps)) best = rate;
  }
  return best;
}
