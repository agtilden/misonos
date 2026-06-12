import { allTagBlocks, attrText, tagText } from "@misonos/sonos-protocol";
import type { MusicServiceDescriptor, MusicServiceDiscovery, SonosAccount, SonosAccountsResponse, SonosZone } from "@misonos/sonos-protocol";
import { callSoap, SonosSoapError } from "./sonosSoap.js";

export type { MusicServiceDescriptor, MusicServiceDiscovery, SonosAccount, SonosAccountsResponse };

export async function fetchSonosAccounts(seed: SonosZone, timeoutMs = 5000): Promise<SonosAccountsResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${seed.ipAddress}:1400/status/accounts`, {
      headers: { Accept: "text/xml" },
      signal: controller.signal
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`status/accounts returned ${response.status}: ${raw.slice(0, 200)}`);
    }
    return {
      accounts: parseAccounts(raw),
      raw,
      fetchedAt: new Date().toISOString()
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseAccounts(xml: string): SonosAccount[] {
  const accounts: SonosAccount[] = [];
  for (const block of allTagBlocks(xml, "Account")) {
    const typeText = attrText(block, "Type");
    if (!typeText) continue;
    const type = Number.parseInt(typeText, 10);
    if (Number.isNaN(type)) continue;
    accounts.push({
      type,
      serialNum: attrText(block, "SerialNum"),
      username: tagText(block, "UN"),
      metadata: tagText(block, "MD"),
      nickname: tagText(block, "NN"),
      oaDeviceId: tagText(block, "OADevID"),
      key: tagText(block, "Key")
    });
  }
  return accounts;
}

export async function discoverMusicServices(seed: SonosZone): Promise<MusicServiceDiscovery> {
  const response = await callSoap(seed.ipAddress, "MusicServices", "ListAvailableServices");
  const descriptorXml = response.AvailableServiceDescriptorList ?? "";
  const services = parseServices(descriptorXml);
  const youtubeMusic = services.find((service) => /youtube/i.test(service.name));
  const result: MusicServiceDiscovery = { services, youtubeMusic, fetchedAt: new Date().toISOString() };
  if (youtubeMusic) {
    result.session = await tryGetSessionId(seed, youtubeMusic.id);
  }
  return result;
}

function parseServices(xml: string): MusicServiceDescriptor[] {
  const services: MusicServiceDescriptor[] = [];
  for (const block of allTagBlocks(xml, "Service")) {
    const idText = attrText(block, "Id");
    if (!idText) continue;
    const id = Number.parseInt(idText, 10);
    if (Number.isNaN(id)) continue;
    services.push({
      id,
      name: attrText(block, "Name") ?? `Service ${id}`,
      version: attrText(block, "Version"),
      uri: attrText(block, "Uri"),
      secureUri: attrText(block, "SecureUri"),
      containerType: attrText(block, "ContainerType"),
      capabilities: attrText(block, "Capabilities"),
      authType: parsePolicyAuth(block),
      pollInterval: parsePolicyPoll(block),
      manifestUri: tagText(block, "ManifestUri")
    });
  }
  return services;
}

function parsePolicyAuth(serviceBlock: string): string | undefined {
  const policy = matchSelfClosing(serviceBlock, "Policy");
  return policy ? attrText(policy, "Auth") : undefined;
}

function parsePolicyPoll(serviceBlock: string): string | undefined {
  const policy = matchSelfClosing(serviceBlock, "Policy");
  return policy ? attrText(policy, "PollInterval") : undefined;
}

function matchSelfClosing(block: string, tagName: string): string | undefined {
  const pattern = new RegExp(`<${tagName}\\b[^>]*/?>`, "i");
  const match = block.match(pattern);
  return match?.[0];
}

async function tryGetSessionId(seed: SonosZone, serviceId: number): Promise<MusicServiceDiscovery["session"]> {
  try {
    const response = await callSoap(seed.ipAddress, "MusicServices", "GetSessionId", {
      ServiceId: serviceId,
      Username: ""
    });
    return {
      serviceId,
      sessionId: response.SessionId,
      username: response.Username
    };
  } catch (error) {
    return {
      serviceId,
      error: error instanceof SonosSoapError
        ? `${error.faultCode ?? "fault"}: ${error.message}`
        : error instanceof Error
          ? error.message
          : "Unknown error"
    };
  }
}
