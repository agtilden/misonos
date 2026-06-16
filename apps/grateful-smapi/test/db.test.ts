import { describe, expect, it } from "vitest";
import { recordingLabel } from "../src/db.js";

describe("recordingLabel", () => {
  const cases: [string, string][] = [
    // The three recordings of 1974-03-23 (Cow Palace) — identical archive titles,
    // distinguishable only here.
    ["gd1974-03-23.sbd.clugston-orf.1995.sbeok.shnf", "Soundboard · clugston-orf"],
    ["gd1974-03-23.aud.connors.hughey.gems.78599.flac16", "Audience · connors"],
    ["gd1974-03-23.aud.OBV-GEMS.83453.flac16", "Audience · OBV-GEMS"],
    // Source variants.
    ["gd90-10-17.dsbd.wiley.11613.sbeok.shnf", "Soundboard · wiley"],
    ["gd1977-05-08.mtx.seamons.91101.flac16", "Matrix · seamons"],
    ["gd1989-10-19.fob.sennme80.wklitz.101809.flac16", "Audience · sennme80"],
    // Microphone brand as the source token implies an audience tape.
    ["gd84-04-29.beyer.miller.15390.sbeok.shnf", "Audience · miller"],
    // Numeric and format/junk tokens are skipped when choosing the lineage name.
    ["gd1971-05-30.sbd.miller.94119.flac16", "Soundboard · miller"],
    ["gd1984-11-02.senn421.unknown.gastwirt.gems.77878.sbeok.flac16", "Audience · gastwirt"]
  ];

  for (const [id, label] of cases) {
    it(`labels ${id}`, () => {
      expect(recordingLabel(id)).toBe(label);
    });
  }

  it("falls back to a bare source when there is no lineage token", () => {
    expect(recordingLabel("gd1971-05-30.sbd.94119.flac16")).toBe("Soundboard");
  });
});
