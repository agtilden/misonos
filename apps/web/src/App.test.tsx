import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { DialogProvider } from "./dialogs.js";
import { FavoritesProvider } from "./favorites.js";
import { LocalPlayerProvider } from "./localPlayer.js";

class FakeEventSource {
  onerror: (() => void) | null = null;
  private listeners = new Map<string, EventListener>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, listener);
  }

  close() {}
}

describe("App", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/groups")) return json([{ id: "g1", coordinatorId: "z1", coordinatorName: "Kitchen", zones: [] }]);
      if (url.endsWith("/api/zones")) return json([{ id: "z1", uuid: "z1", name: "Kitchen", ipAddress: "10.0.0.2", location: "", visible: true }]);
      if (url.endsWith("/api/sources")) return json([]);
      if (url.endsWith("/now-playing")) return json({ groupId: "g1", state: "PLAYING", title: "Song", position: "0:01:07", duration: "0:04:04", updatedAt: new Date().toISOString() });
      if (url.endsWith("/queue")) return json([{ id: "q1", title: "Song" }]);
      return json({ groups: [{ id: "g1", coordinatorId: "z1", coordinatorName: "Kitchen", zones: [] }], zones: [] });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the controller shell", async () => {
    render(<DialogProvider><FavoritesProvider><LocalPlayerProvider><App /></LocalPlayerProvider></FavoritesProvider></DialogProvider>);
    expect(await screen.findByLabelText("Settings")).toBeInTheDocument();
    expect(await screen.findByText(/^(Mint|Amber|Sky|Coral|Lilac|Lime|Pink|Olive)$/)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Song" })).toBeInTheDocument();
    expect(await screen.findByRole("meter", { name: "Playback progress (click to seek)" })).toBeInTheDocument();
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
