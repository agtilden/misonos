import type { SonosGroup, SonosZone } from "@misonos/sonos-protocol";
import { allTagBlocks, attrText, selfClosingTags, tagText } from "@misonos/sonos-protocol";

export function zoneFromDeviceDescription(ipAddress: string, location: string, xml: string): SonosZone {
  const uuid = (tagText(xml, "UDN") ?? `uuid:${ipAddress}`).replace(/^uuid:/, "");
  return {
    id: uuid,
    uuid,
    name: tagText(xml, "roomName") ?? tagText(xml, "friendlyName") ?? ipAddress,
    ipAddress,
    location,
    visible: true
  };
}

export function parseZoneGroupState(xml: string): { zones: SonosZone[]; groups: SonosGroup[] } {
  const zones = new Map<string, SonosZone>();
  const groups: SonosGroup[] = [];

  for (const groupBlock of allTagBlocks(xml, "ZoneGroup")) {
    const coordinatorId = attrText(groupBlock, "Coordinator") ?? "";
    const groupId = attrText(groupBlock, "ID") ?? coordinatorId;
    const groupZones: SonosZone[] = [];

    for (const memberTag of selfClosingTags(groupBlock, "ZoneGroupMember")) {
      const uuid = attrText(memberTag, "UUID") ?? attrText(memberTag, "Uuid") ?? "";
      if (!uuid) continue;
      const location = attrText(memberTag, "Location") ?? "";
      const ipAddress = location.match(/^https?:\/\/([^/:]+)/i)?.[1] ?? "";
      const zone: SonosZone = {
        id: uuid,
        uuid,
        name: attrText(memberTag, "ZoneName") ?? ipAddress ?? uuid,
        ipAddress,
        location,
        coordinatorId,
        groupId,
        visible: attrText(memberTag, "Invisible") !== "1"
      };
      zones.set(uuid, zone);
      groupZones.push(zone);
    }

    const coordinator = groupZones.find((zone) => zone.uuid === coordinatorId) ?? groupZones[0];
    if (coordinator) {
      groups.push({
        id: groupId,
        coordinatorId: coordinator.uuid,
        coordinatorName: coordinator.name,
        zones: groupZones
      });
    }
  }

  return { zones: [...zones.values()], groups };
}
