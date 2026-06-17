import { describe, expect, it } from "vitest";
import { stripAdParams } from "../src/tunein.js";

describe("stripAdParams", () => {
  it("removes AdsWizz ad-session params from a TuneIn stream URL", () => {
    const raw =
      "https://tunein.cdnstream1.com/2877_96.mp3?aw_0_1st.skey=1781701058&lat=40.7&lon=-73.9&aw_0_1st.stationId=s29290&source=TuneIn&aw_0_azn.planguage=en&delivery=1";
    const cleaned = new URL(stripAdParams(raw));
    expect([...cleaned.searchParams.keys()].some((k) => k.toLowerCase().startsWith("aw_"))).toBe(false);
    // Non-ad params (and the mount path) survive.
    expect(cleaned.pathname).toBe("/2877_96.mp3");
    expect(cleaned.searchParams.get("lat")).toBe("40.7");
    expect(cleaned.searchParams.get("source")).toBe("TuneIn");
    expect(cleaned.searchParams.get("delivery")).toBe("1");
  });

  it("preserves a genuine auth token on a non-TuneIn mount", () => {
    const raw = "https://stream.example.com/live.aac?token=abc123&tdsdk=js";
    expect(stripAdParams(raw)).toBe(raw);
  });

  it("returns plain stream URLs unchanged", () => {
    const raw = "https://centova5.transmissaodigital.com:20104/";
    expect(stripAdParams(raw)).toBe(raw);
  });

  it("leaves a non-URL string untouched", () => {
    expect(stripAdParams("not a url")).toBe("not a url");
  });
});
