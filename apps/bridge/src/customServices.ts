import { networkInterfaces } from "node:os";
import { callSoap } from "./sonosSoap.js";

export type CustomServiceAuth = "Anonymous" | "UserId" | "DeviceLink" | "AppLink";

export interface CustomServicePreset {
  id: string;
  name: string;
  description: string;
  // Sonos identifies a music service by this slot id. Each preset MUST use a
  // distinct sid — registering two services on the same sid overwrites the first,
  // which silently de-registers it (and breaks any x-sonos-http:…sid= URIs that
  // depend on it). youtube-music stays 240 to match SMAPI_SOURCE_INFO and the
  // sid baked into already-enqueued YT play URIs.
  sid: number;
  // true: MiSonos can only play this source once the service is registered on a
  // speaker (it streams via x-sonos-http:…sid=, which Sonos resolves through the
  // registered service). false: MiSonos already plays it via the stream proxy;
  // registering only also surfaces it in the official Sonos app / other controllers.
  registrationRequired: boolean;
  port: number;
  path?: string;
  authType: CustomServiceAuth;
  pollInterval: number;
  containerType: string;
  capabilities?: string;
  presentationMapUri?: string;
  stringsUri?: string;
}

export const CUSTOM_SERVICE_PRESETS: CustomServicePreset[] = [
  {
    id: "youtube-music",
    name: "MiSonos YT Music",
    description: "Bridge for YouTube Music streams; unlocks full track metadata on Sonos S1.",
    sid: 240,
    registrationRequired: true,
    port: 4321,
    authType: "Anonymous",
    pollInterval: 3600,
    containerType: "MService"
  },
  {
    id: "grateful-dead-archive",
    name: "Grateful Dead Archive",
    description: "Live recordings from archive.org, served by the bundled grateful-smapi process.",
    sid: 241,
    registrationRequired: false,
    port: 4319,
    authType: "Anonymous",
    pollInterval: 30,
    containerType: "MService"
  },
  {
    id: "live-music-archive",
    name: "Live Music Archive",
    description: "Thousands of taper-friendly bands from archive.org's etree collection, served by the bundled lma-smapi process.",
    sid: 242,
    registrationRequired: false,
    port: 4322,
    authType: "Anonymous",
    pollInterval: 3600,
    containerType: "MService"
  }
];

export interface CustomServicePresetView extends CustomServicePreset {
  uri: string | null;
  detectedHostIp: string | null;
}

export function listPresets(): CustomServicePresetView[] {
  const ip = detectLanIp();
  return CUSTOM_SERVICE_PRESETS.map((preset) => ({
    ...preset,
    detectedHostIp: ip,
    uri: ip ? buildServiceUri(preset, ip) : null
  }));
}

export function getPreset(id: string): CustomServicePreset | undefined {
  return CUSTOM_SERVICE_PRESETS.find((preset) => preset.id === id);
}

export function buildServiceUri(preset: CustomServicePreset, host: string): string {
  const path = preset.path ?? "/";
  return `http://${host}:${preset.port}${path}`;
}

export function detectLanIp(): string | null {
  // Skip Tailscale/VPN CGNAT (100.64.0.0/10) and link-local — Sonos speakers are
  // on the physical LAN and can't be reached over those. Prefer a real
  // private-LAN address; fall back to the first usable one otherwise.
  let fallback: string | null = null;
  for (const list of Object.values(networkInterfaces())) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      if (isCgnat(iface.address) || iface.address.startsWith("169.254.")) continue;
      fallback ??= iface.address;
      if (isPrivateLan(iface.address)) return iface.address;
    }
  }
  return fallback;
}

function isCgnat(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

function isPrivateLan(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  if (a === 192 && b === 168) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export interface RegisterCustomServiceResult {
  status: number;
  body: string;
  attemptedUri: string;
  speakerIp: string;
  // Set when the target speaker is S2 (no customsd page): registration is
  // neither possible nor needed — the source plays directly via the proxy.
  registrationUnavailable?: boolean;
  accountType?: string;
  accountUdn?: string;
  accountError?: string;
  refreshError?: string;
}

export async function registerCustomService(options: {
  speakerIp: string;
  preset: CustomServicePreset;
  uri: string;
  secureUri?: string;
  sid?: string;
}): Promise<RegisterCustomServiceResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const formResponse = await fetch(`http://${options.speakerIp}:1400/customsd.htm`, { signal: controller.signal });
    if (!formResponse.ok) {
      const text = await formResponse.text();
      return { status: formResponse.status, body: text, attemptedUri: options.uri, speakerIp: options.speakerIp };
    }
    const formHtml = await formResponse.text();
    const csrfMatch = formHtml.match(/name="csrfToken"\s+value="([^"]+)"/);
    if (!csrfMatch) {
      return { status: 0, body: "csrfToken not found in customsd.htm form", attemptedUri: options.uri, speakerIp: options.speakerIp };
    }

    const form = new URLSearchParams();
    form.set("csrfToken", csrfMatch[1]);
    form.set("sid", options.sid ?? DEFAULT_CUSTOM_SID);
    form.set("name", options.preset.name);
    form.set("uri", options.uri);
    // A blank secureUri renders the service unplayable (Play fails with 701
    // even though registration reports Success) — mirror the plain-http uri.
    form.set("secureUri", options.secureUri || options.uri);
    form.set("pollInterval", String(options.preset.pollInterval));
    form.set("authType", options.preset.authType);
    form.set("containerType", options.preset.containerType);
    form.set("stringsVersion", "0");
    form.set("stringsUri", options.preset.stringsUri ?? "");
    form.set("presentationMapVersion", "0");
    form.set("presentationMapUri", options.preset.presentationMapUri ?? "");
    form.set("manifestVersion", "0");
    form.set("manifestUri", "");
    if (options.preset.capabilities) {
      for (const cap of options.preset.capabilities.split(",").map((value) => value.trim()).filter(Boolean)) {
        form.append("caps", cap);
      }
    }

    const response = await fetch(`http://${options.speakerIp}:1400/customsd`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: controller.signal
    });
    const body = await response.text();
    // After registering the service definition, also bind a local account so
    // x-sonos-http URIs against sid will resolve without needing the official
    // app's "Add a Service" flow (which is gated on the new Sonos app).
    let accountUdn: string | undefined;
    let accountError: string | undefined;
    let refreshError: string | undefined;
    let accountType: string | undefined;
    try {
      const sid = options.sid ?? DEFAULT_CUSTOM_SID;
      accountType = accountTypeForCustomSid(sid);
      const accountResult = await callSoap(options.speakerIp, "SystemProperties", "AddAccountX", {
        AccountType: accountType,
        AccountID: "",
        AccountPassword: ""
      });
      accountUdn = accountResult.AccountUDN;
      console.log(`[customsd] AddAccountX sid=${sid} accountType=${accountType} -> AccountUDN=${accountUdn}`);
      try {
        await callSoap(options.speakerIp, "MusicServices", "UpdateAvailableServices");
        console.log(`[customsd] UpdateAvailableServices sid=${sid} -> ok`);
      } catch (error) {
        refreshError = error instanceof Error ? error.message : String(error);
        console.warn(`[customsd] UpdateAvailableServices failed: ${refreshError}`);
      }
    } catch (error) {
      accountError = error instanceof Error ? error.message : String(error);
      console.warn(`[customsd] AddAccountX failed: ${accountError}`);
    }
    return { status: response.status, body, attemptedUri: options.uri, speakerIp: options.speakerIp, accountType, accountUdn, accountError, refreshError };
  } finally {
    clearTimeout(timer);
  }
}

// sid 255 is silently dropped by S1 firmware (customsd answers "Success!" but
// the service never appears in ListAvailableServices); 240-253 register for real.
export const DEFAULT_CUSTOM_SID = "240";

function accountTypeForCustomSid(sid: string): string {
  // Queue/playback desc binding is keyed as Svc{sid*256} (low byte 0), not the
  // sid*256+7 service type that ListAvailableServices reports.
  return String(Number.parseInt(sid, 10) * 256);
}
