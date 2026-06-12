import { networkInterfaces } from "node:os";
import { callSoap } from "./sonosSoap.js";

export type CustomServiceAuth = "Anonymous" | "UserId" | "DeviceLink" | "AppLink";

export interface CustomServicePreset {
  id: string;
  name: string;
  description: string;
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
    id: "grateful-dead-archive",
    name: "Grateful Dead Archive",
    description: "Live recordings from archive.org, served by the bundled grateful-smapi process.",
    port: 4319,
    authType: "Anonymous",
    pollInterval: 30,
    containerType: "MService"
  },
  {
    id: "youtube-music",
    name: "MiSonos YT Music",
    description: "Bridge for YouTube Music streams; unlocks full track metadata on Sonos S1.",
    port: 4321,
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
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}

export interface RegisterCustomServiceResult {
  status: number;
  body: string;
  attemptedUri: string;
  speakerIp: string;
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
    form.set("sid", options.sid ?? "255");
    form.set("name", options.preset.name);
    form.set("uri", options.uri);
    form.set("secureUri", options.secureUri ?? "");
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
      const sid = options.sid ?? "255";
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

function accountTypeForCustomSid(sid: string): string {
  // The S1 customsd form accepts raw sid=255, but queue/playback metadata for
  // that slot is keyed as Svc65280 rather than the usual sid*256+7 service type.
  if (sid === "255") return "65280";
  return sid;
}
