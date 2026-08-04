import { describe, expect, it } from "vitest";
import { openingTags, selfClosingTags } from "../src/xml.js";

describe("xml tag helpers", () => {
  it("matches opening tags whether or not they self-close", () => {
    const xml = `<Root><Member id="a"/><Member id="b"><Child id="c"/></Member></Root>`;
    expect(selfClosingTags(xml, "Member")).toEqual([`<Member id="a"/>`]);
    expect(openingTags(xml, "Member")).toEqual([`<Member id="a"/>`, `<Member id="b">`]);
  });

  it("does not let an opening tag span past its own '>'", () => {
    const xml = `<Member Location="http://10.0.0.2:1400/xml/device_description.xml"><Sat id="s"/></Member>`;
    expect(openingTags(xml, "Member")).toEqual([
      `<Member Location="http://10.0.0.2:1400/xml/device_description.xml">`
    ]);
  });

  it("does not match tags that merely share a name prefix", () => {
    const xml = `<Zone id="a"/><ZoneMember id="b"/>`;
    expect(openingTags(xml, "Zone")).toEqual([`<Zone id="a"/>`]);
  });
});
