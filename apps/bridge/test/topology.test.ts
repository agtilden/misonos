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
