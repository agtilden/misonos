import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl, currentServerUrl, isCurrent, loadServers, normalizeUrl, switchToServer } from "./servers.js";
import { artSrc } from "./api.js";

// The home host the PWA shell is served from, plus a second backend to switch to.
const HOME = "https://closetnode.civet-acrux.ts.net";
const SHORE = "https://manto.civet-acrux.ts.net";

describe("API base / location switching", () => {
  let reload: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    localStorage.clear();
    // switchToServer reloads in place; jsdom can't navigate and its location.reload is
    // non-configurable, so swap window.location for a stub carrying the bits we read.
    originalLocation = window.location;
    reload = vi.fn();
    const home = new URL(HOME);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { origin: home.origin, hostname: home.hostname, href: `${HOME}/`, reload },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    localStorage.clear();
  });

  it("is a no-op by default: the API stays same-origin and home is current", () => {
    expect(apiUrl("/api/zones")).toBe("/api/zones");
    expect(currentServerUrl()).toBe(HOME);
    expect(isCurrent({ name: "NYC", url: HOME })).toBe(true);
  });

  it("switching repoints the API base and reloads in place — it never navigates cross-origin", () => {
    switchToServer({ name: "Shore", url: SHORE });

    expect(window.location.reload).toHaveBeenCalledOnce();
    expect(window.location.origin).toBe(HOME); // still on the home origin → PWA stays in scope

    // After the reload the persisted base sends every /api call to the chosen backend.
    expect(apiUrl("/api/zones")).toBe(`${SHORE}/api/zones`);
    expect(currentServerUrl()).toBe(SHORE);
    expect(isCurrent({ name: "Shore", url: SHORE })).toBe(true);
    expect(isCurrent({ name: "NYC", url: HOME })).toBe(false);
  });

  it("switching back to the home origin clears the base", () => {
    switchToServer({ name: "Shore", url: SHORE });
    switchToServer({ name: "NYC", url: HOME });

    expect(apiUrl("/api/zones")).toBe("/api/zones");
    expect(currentServerUrl()).toBe(HOME);
  });

  it("routes album art and other /api assets at the selected backend after switching", () => {
    switchToServer({ name: "Shore", url: SHORE });

    const yt = "https://yt3.googleusercontent.com/abc=w226";
    expect(artSrc(yt)).toBe(`${SHORE}/api/art?u=${encodeURIComponent(yt)}`);
    expect(artSrc("/api/art?u=x")).toBe(`${SHORE}/api/art?u=x`); // already-proxied, root-relative
    expect(artSrc("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA"); // untouched
  });

  it("always lists the home origin so it can be switched back to", () => {
    expect(loadServers().some((s) => s.url === HOME)).toBe(true);
  });

  it("normalizeUrl coerces free-form input to a canonical origin", () => {
    expect(normalizeUrl("shore:4317")).toBe("http://shore:4317");
    expect(normalizeUrl("https://x.ts.net/")).toBe("https://x.ts.net");
    expect(normalizeUrl("   ")).toBeNull();
  });
});
