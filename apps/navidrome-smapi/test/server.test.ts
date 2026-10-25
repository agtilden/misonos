import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const realFetch = globalThis.fetch;
const TAG_ALLOWANCE = 16 * 1024;

const SONGS: Record<string, object> = {
  op: { id: "op", title: "Opus song", suffix: "opus", duration: 200, bitRate: 330 },
  // Navidrome's bitRate for this one predicts 128 kbps, but the transcode says 320.
  lo: { id: "lo", title: "Mislabelled", suffix: "opus", duration: 200, bitRate: 130 },
  mp: { id: "mp", title: "MP3 song", suffix: "mp3", duration: 200, size: 5000 }
};

// A transcode as Navidrome sends it: an ID3 tag, then 320 kbps frames (just headers here).
function transcode(length: number): Uint8Array {
  if (length === 0) return new Uint8Array(0);
  const body = new Uint8Array(length).fill(0x55);
  body.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 20], 0);
  body.set([0xff, 0xfb, 0xe4, 0x00], 30);
  return body;
}

// A fake Navidrome behind the Cloudflare tunnel: full responses arrive without a Content-Length.
function fakeNavidrome(seen: URL[], transcodeLength: number): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host !== "nd.test") return realFetch(input, init);
    seen.push(url);
    const endpoint = url.pathname.replace("/rest/", "");
    const id = url.searchParams.get("id") ?? "";
    if (endpoint === "getSong") {
      const body = { "subsonic-response": { status: "ok", song: SONGS[id] } };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }
    if (endpoint === "getCoverArt") throw new TypeError("fetch failed");
    if (endpoint === "stream" && url.searchParams.get("format") === "raw") {
      const range = new Headers(init?.headers).get("range");
      if (range) {
        return new Response(new Uint8Array(100), {
          status: 206,
          headers: { "content-type": "audio/mpeg", "content-range": "bytes 0-99/5000", "content-length": "100" }
        });
      }
      return new Response(new Uint8Array(5000), { headers: { "content-type": "audio/mpeg" } });
    }
    if (endpoint === "stream") {
      return new Response(init?.method === "HEAD" ? null : transcode(transcodeLength), { headers: { "content-type": "audio/mpeg" } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

describe("/stream", () => {
  let server: http.Server;
  let base: string;
  let seen: URL[];

  async function start(transcodeLength: number): Promise<void> {
    seen = [];
    vi.stubGlobal("fetch", fakeNavidrome(seen, transcodeLength));
    server = createServer(loadConfig({
      MISONOS_NAVIDROME_SERVER_URL: "http://nd.test",
      MISONOS_NAVIDROME_USER: "me",
      MISONOS_NAVIDROME_PASSWORD: "secret"
    }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const streamCalls = () => seen.filter((url) => url.pathname.endsWith("/stream"));

  beforeEach(() => start(1_000_000));
  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise((resolve) => server.close(resolve));
  });

  it("answers HEAD for a transcode with its size, without starting one", async () => {
    const response = await realFetch(`${base}/stream?id=op`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(201 * 40_000 + TAG_ALLOWANCE));
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(streamCalls()).toHaveLength(0);
  });

  it("pads a transcode that ends short to the length it advertised", async () => {
    const response = await realFetch(`${base}/stream?id=op`);
    const body = new Uint8Array(await response.arrayBuffer());
    const length = Number(response.headers.get("content-length"));
    expect(length).toBe(201 * 40_000 + TAG_ALLOWANCE);
    expect(body.length).toBe(length);
    expect(body.subarray(0, 3)).toEqual(Uint8Array.from([0x49, 0x44, 0x33]));
    expect(body[999_999]).toBe(0x55);
    expect(body[1_000_000]).toBe(0);
    expect(streamCalls()[0].searchParams.get("maxBitRate")).toBe("320");
  });

  it("serves a byte Range as a time offset into the transcode", async () => {
    const response = await realFetch(`${base}/stream?id=op`, { headers: { range: "bytes=4000000-4000099" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 4000000-4000099/${201 * 40_000 + TAG_ALLOWANCE}`);
    expect((await response.arrayBuffer()).byteLength).toBe(100);
    expect(streamCalls()[0].searchParams.get("timeOffset")).toBe("100");
  });

  it("refuses a range past the end without starting a transcode", async () => {
    const response = await realFetch(`${base}/stream?id=op`, { headers: { range: "bytes=99999999-" } });
    expect(response.status).toBe(416);
    expect(streamCalls()).toHaveLength(0);
  });

  it("trusts the transcode's own bitrate over the prediction, then and for later seeks", async () => {
    const first = await realFetch(`${base}/stream?id=lo`);
    await first.arrayBuffer();
    expect(first.headers.get("content-length")).toBe(String(201 * 40_000 + TAG_ALLOWANCE));
    const seek = await realFetch(`${base}/stream?id=lo`, { headers: { range: "bytes=4000000-4000009" } });
    await seek.arrayBuffer();
    expect(streamCalls()[1].searchParams.get("timeOffset")).toBe("100");
  });

  it("cuts a transcode that runs long at the length it advertised", async () => {
    await new Promise((resolve) => server.close(resolve));
    await start(201 * 40_000 + TAG_ALLOWANCE + 5000);
    const response = await realFetch(`${base}/stream?id=op`);
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.length).toBe(Number(response.headers.get("content-length")));
  });

  it("reports an empty transcode as an error rather than a file of padding", async () => {
    await new Promise((resolve) => server.close(resolve));
    await start(0);
    const response = await realFetch(`${base}/stream?id=op`);
    expect(response.status).toBe(502);
  });

  it("answers 502 when the server can't be reached", async () => {
    const response = await realFetch(`${base}/art?id=al-1`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "fetch failed" });
  });

  it("keeps a raw file's status and fills in a Content-Length the proxy dropped", async () => {
    const full = await realFetch(`${base}/stream?id=mp`);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-length")).toBe("5000");
    expect((await full.arrayBuffer()).byteLength).toBe(5000);

    const range = await realFetch(`${base}/stream?id=mp`, { headers: { range: "bytes=0-99" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 0-99/5000");
    expect((await range.arrayBuffer()).byteLength).toBe(100);
  });
});
