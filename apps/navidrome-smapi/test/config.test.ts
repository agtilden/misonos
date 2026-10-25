import { describe, expect, it } from "vitest";
import { loadConfig, serverFromConfig } from "../src/config.js";

describe("navidrome config", () => {
  it("uses defaults and stays unconfigured without a server", () => {
    const config = loadConfig({});
    expect(config.port).toBe(4325);
    expect(config.transcodeFormat).toBe("mp3");
    expect(config.maxBitRate).toBe(320);
    expect(serverFromConfig(config)).toBeUndefined();
  });

  it("needs url, user and password together", () => {
    const partial = loadConfig({ MISONOS_NAVIDROME_SERVER_URL: "http://nd:4533", MISONOS_NAVIDROME_USER: "me" });
    expect(serverFromConfig(partial)).toBeUndefined();
    const full = loadConfig({
      MISONOS_NAVIDROME_SERVER_URL: "http://nd:4533/",
      MISONOS_NAVIDROME_USER: "me",
      MISONOS_NAVIDROME_PASSWORD: "secret"
    });
    expect(serverFromConfig(full)).toEqual({ serverUrl: "http://nd:4533", username: "me", password: "secret" });
  });

  it("treats compose-interpolated blanks as unset", () => {
    const config = loadConfig({
      MISONOS_NAVIDROME_SERVER_URL: "",
      MISONOS_NAVIDROME_PUBLIC_URL: "http://:4325",
      MISONOS_NAVIDROME_MAX_BITRATE: ""
    });
    expect(config.serverUrl).toBeUndefined();
    expect(config.publicUrl).toBeUndefined();
    expect(config.maxBitRate).toBe(320);
  });
});
