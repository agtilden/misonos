import { describe, expect, it } from "vitest";
import { parseSsdpHeaders } from "../src/ssdp.js";
import { eventUrlForService, controlUrlForService } from "../src/sonosSoap.js";
import { parseZoneGroupState } from "../src/topology.js";

describe("bridge parsing", () => {
  it("parses SSDP headers case-insensitively", () => {
    expect(parseSsdpHeaders("LOCATION: http://10.0.0.2:1400/xml/device_description.xml\r\nUSN: uuid:test")).toEqual({
      location: "http://10.0.0.2:1400/xml/device_description.xml",
      usn: "uuid:test"
    });
  });

  it("normalizes zone group state", () => {
    const state = `<ZoneGroups><ZoneGroup Coordinator="RINCON_A" ID="RINCON_A:1"><ZoneGroupMember UUID="RINCON_A" Location="http://10.0.0.2:1400/xml/zone_player.xml" ZoneName="Kitchen"/><ZoneGroupMember UUID="RINCON_B" Location="http://10.0.0.3:1400/xml/zone_player.xml" ZoneName="Office"/></ZoneGroup></ZoneGroups>`;
    const topology = parseZoneGroupState(state);
    expect(topology.groups[0].coordinatorName).toBe("Kitchen");
    expect(topology.zones.map((zone) => zone.ipAddress)).toEqual(["10.0.0.2", "10.0.0.3"]);
  });

  it("parses the SWGen software generation when present (drives S2 proxy routing)", () => {
    const state = `<ZoneGroups><ZoneGroup Coordinator="RINCON_A" ID="RINCON_A:1"><ZoneGroupMember UUID="RINCON_A" Location="http://10.0.0.2:1400/xml/zone_player.xml" ZoneName="Den" SWGen="2"/><ZoneGroupMember UUID="RINCON_B" Location="http://10.0.0.3:1400/xml/zone_player.xml" ZoneName="Legacy" SWGen="1"/><ZoneGroupMember UUID="RINCON_C" Location="http://10.0.0.4:1400/xml/zone_player.xml" ZoneName="Unknown"/></ZoneGroup></ZoneGroups>`;
    const topology = parseZoneGroupState(state);
    const byName = Object.fromEntries(topology.zones.map((zone) => [zone.name, zone.swGen]));
    expect(byName).toEqual({ Den: 2, Legacy: 1, Unknown: undefined });
  });

  it("parses bonded home theater groups whose coordinator wraps <Satellite/> children", () => {
    const state = `<ZoneGroups><ZoneGroup Coordinator="RINCON_ARC" ID="RINCON_ARC:1"><ZoneGroupMember UUID="RINCON_ARC" Location="http://10.0.0.2:1400/xml/device_description.xml" ZoneName="TV Room" SWGen="2" HTSatChanMapSet="RINCON_ARC:LF,RF;RINCON_SUB:SW;RINCON_SL:LR;RINCON_SR:RR"><Satellite UUID="RINCON_SL" Location="http://10.0.0.5:1400/xml/device_description.xml" ZoneName="TV Room" Invisible="1" SWGen="2"/><Satellite UUID="RINCON_SR" Location="http://10.0.0.6:1400/xml/device_description.xml" ZoneName="TV Room" Invisible="1" SWGen="2"/><Satellite UUID="RINCON_SUB" Location="http://10.0.0.7:1400/xml/device_description.xml" ZoneName="Sub Mini" Invisible="1" SWGen="2"/></ZoneGroupMember></ZoneGroup></ZoneGroups>`;
    const topology = parseZoneGroupState(state);
    expect(topology.zones).toHaveLength(4);
    expect(topology.groups).toHaveLength(1);
    expect(topology.groups[0].coordinatorName).toBe("TV Room");
    expect(topology.groups[0].zones).toHaveLength(4);
    // Satellites declare Invisible="1", so the room still shows up once in the UI.
    expect(topology.zones.filter((zone) => zone.visible).map((zone) => zone.name)).toEqual(["TV Room"]);
    expect(topology.zones.find((zone) => zone.uuid === "RINCON_SUB")?.ipAddress).toBe("10.0.0.7");
  });

  it("keeps standalone members alongside a bonded coordinator in the same group", () => {
    const state = `<ZoneGroups><ZoneGroup Coordinator="RINCON_ARC" ID="RINCON_ARC:1"><ZoneGroupMember UUID="RINCON_ARC" Location="http://10.0.0.2:1400/xml/device_description.xml" ZoneName="TV Room" SWGen="2"><Satellite UUID="RINCON_SL" Location="http://10.0.0.5:1400/xml/device_description.xml" ZoneName="TV Room" Invisible="1"/></ZoneGroupMember><ZoneGroupMember UUID="RINCON_K" Location="http://10.0.0.3:1400/xml/device_description.xml" ZoneName="Kitchen" SWGen="2"/></ZoneGroup></ZoneGroups>`;
    const topology = parseZoneGroupState(state);
    expect(topology.zones.map((zone) => zone.uuid)).toEqual(["RINCON_ARC", "RINCON_K", "RINCON_SL"]);
    expect(topology.groups[0].coordinatorName).toBe("TV Room");
  });

  it("uses real Sonos service control paths", () => {
    expect(controlUrlForService("AVTransport")).toBe("/MediaRenderer/AVTransport/Control");
    expect(controlUrlForService("RenderingControl")).toBe("/MediaRenderer/RenderingControl/Control");
    expect(controlUrlForService("ContentDirectory")).toBe("/MediaServer/ContentDirectory/Control");
    expect(controlUrlForService("ZoneGroupTopology")).toBe("/ZoneGroupTopology/Control");
  });

  it("uses real Sonos service event paths", () => {
    expect(eventUrlForService("AVTransport")).toBe("/MediaRenderer/AVTransport/Event");
    expect(eventUrlForService("RenderingControl")).toBe("/MediaRenderer/RenderingControl/Event");
    expect(eventUrlForService("ContentDirectory")).toBe("/MediaServer/ContentDirectory/Event");
    expect(eventUrlForService("ZoneGroupTopology")).toBe("/ZoneGroupTopology/Event");
  });
});
