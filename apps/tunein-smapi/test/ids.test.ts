import { describe, expect, it } from "vitest";
import { decodeId, encodeId, type TuneInId } from "../src/ids.js";

describe("tunein id round-trip", () => {
  const cases: TuneInId[] = [
    { kind: "root" },
    { kind: "favorites" },
    { kind: "guide", url: "http://opml.radiotime.com/Browse.ashx?c=music&filter=s:popular" },
    { kind: "station", guideId: "s32599", name: "KEXP", image: "http://cdn/logo.jpg", subtext: "Seattle" }
  ];

  for (const id of cases) {
    it(`survives encode/decode for ${id.kind}`, () => {
      expect(decodeId(encodeId(id))).toEqual(id);
    });
  }

  it("preserves a station with no optional metadata", () => {
    const id: TuneInId = { kind: "station", guideId: "s1", name: "Bare Station" };
    expect(decodeId(encodeId(id))).toEqual(id);
  });

  it("rejects unknown ids", () => {
    expect(() => decodeId("nope:whatever")).toThrow();
  });
});
