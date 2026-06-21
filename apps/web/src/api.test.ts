import { describe, expect, it } from "vitest";
import { artSrc } from "./api.js";

describe("artSrc", () => {
  it("routes absolute http(s) art through the caching /api/art proxy", () => {
    // A representative YouTube Music yt3 thumbnail — the `=` in its sizing suffix
    // must be percent-encoded so it survives as the `u=` query value.
    const yt = "https://yt3.googleusercontent.com/abc123=w226-h226-l90-rj";
    expect(artSrc(yt)).toBe(`/api/art?u=${encodeURIComponent(yt)}`);
    expect(artSrc(yt)).toContain("%3Dw226-h226"); // `=` encoded, not passed raw
    expect(artSrc("http://example.com/cover.jpg")).toBe("/api/art?u=http%3A%2F%2Fexample.com%2Fcover.jpg");
  });

  it("matches the scheme case-insensitively", () => {
    expect(artSrc("HTTPS://cdn.example/x.png")).toBe("/api/art?u=HTTPS%3A%2F%2Fcdn.example%2Fx.png");
  });

  it("passes relative and non-http art through unchanged", () => {
    // The proxy resolves `u=` with `new URL()`, which only works on absolute URLs,
    // so anything else must reach the <img> verbatim.
    expect(artSrc("/source-icons/ytmusic.svg")).toBe("/source-icons/ytmusic.svg");
    expect(artSrc("data:image/png;base64,iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(artSrc("blob:http://localhost/abc-123")).toBe("blob:http://localhost/abc-123");
  });

  it("returns undefined for missing art so callers fall back to the placeholder", () => {
    expect(artSrc(undefined)).toBeUndefined();
    expect(artSrc(null)).toBeUndefined();
    expect(artSrc("")).toBeUndefined();
  });
});
