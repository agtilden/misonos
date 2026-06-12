import { tagText } from "@misonos/sonos-protocol";
import type { SonosDeviceInfo, SonosZone } from "@misonos/sonos-protocol";

const TIMEOUT_MS = 5000;

export async function fetchDeviceInfo(zone: SonosZone): Promise<SonosDeviceInfo> {
  const [zpInfo, description] = await Promise.all([
    fetchText(`http://${zone.ipAddress}:1400/status/zp`),
    fetchText(`http://${zone.ipAddress}:1400/xml/device_description.xml`)
  ]);

  return {
    uuid: zone.uuid,
    zoneName: tagText(zpInfo ?? "", "ZoneName") ?? zone.name,
    roomName: tagText(description ?? "", "roomName") ?? zone.name,
    modelName: tagText(description ?? "", "modelName"),
    displayName: tagText(description ?? "", "displayName"),
    modelNumber: tagText(description ?? "", "modelNumber"),
    serialNumber: tagText(zpInfo ?? "", "SerialNumber"),
    softwareVersion: tagText(zpInfo ?? "", "SoftwareVersion"),
    softwareDate: tagText(zpInfo ?? "", "SoftwareDate"),
    swGen: tagText(zpInfo ?? "", "SWGen"),
    minCompatibleVersion: tagText(zpInfo ?? "", "MinCompatibleVersion"),
    hardwareVersion: tagText(zpInfo ?? "", "HardwareVersion"),
    dspVersion: tagText(zpInfo ?? "", "DspVersion"),
    ipAddress: tagText(zpInfo ?? "", "IPAddress") ?? zone.ipAddress,
    macAddress: tagText(zpInfo ?? "", "MACAddress"),
    extraInfo: tagText(zpInfo ?? "", "ExtraInfo"),
    householdId: tagText(zpInfo ?? "", "HouseholdControlID"),
    fetchedAt: new Date().toISOString()
  };
}

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
