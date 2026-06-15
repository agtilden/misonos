import { buildSoapEnvelope, parseSoapResponse, soapActionHeader } from "@misonos/sonos-protocol";

export type ServiceType =
  | "AVTransport"
  | "RenderingControl"
  | "GroupRenderingControl"
  | "ContentDirectory"
  | "DeviceProperties"
  | "ZoneGroupTopology"
  | "MusicServices"
  | "SystemProperties"
  | "AlarmClock";

export class SonosSoapError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly faultCode?: string
  ) {
    super(message);
    this.name = "SonosSoapError";
  }
}

export async function callSoap(
  ipAddress: string,
  serviceType: ServiceType,
  action: string,
  args: Record<string, unknown> = {},
  timeoutMs = 5000
): Promise<Record<string, string>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const body = buildSoapEnvelope(serviceType, 1, action, args);

  try {
    const controlPath = controlUrlForService(serviceType);
    const response = await fetch(`http://${ipAddress}:1400${controlPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=\"utf-8\"",
        SOAPACTION: soapActionHeader(serviceType, 1, action),
        ...additionalHeadersForService(serviceType)
      },
      body,
      signal: controller.signal
    });
    const text = await response.text();
    const parsed = parseSoapResponse(text);

    if (!response.ok || !parsed.ok) {
      const message = `${parsed.fault?.description ?? "Sonos SOAP " + action + " failed"} (code=${parsed.fault?.code ?? "?"})`;
      console.error(`[sonos-soap] ${action} -> ${response.status} ${message}\n  body: ${text.slice(0, 500)}`);
      throw new SonosSoapError(message, response.status, parsed.fault?.code);
    }

    return parsed.values;
  } finally {
    clearTimeout(timer);
  }
}

export function controlUrlForService(serviceType: ServiceType): string {
  switch (serviceType) {
    case "AVTransport":
      return "/MediaRenderer/AVTransport/Control";
    case "RenderingControl":
      return "/MediaRenderer/RenderingControl/Control";
    case "GroupRenderingControl":
      return "/MediaRenderer/GroupRenderingControl/Control";
    case "ContentDirectory":
      return "/MediaServer/ContentDirectory/Control";
    case "DeviceProperties":
      return "/DeviceProperties/Control";
    case "ZoneGroupTopology":
      return "/ZoneGroupTopology/Control";
    case "MusicServices":
      return "/MusicServices/Control";
    case "SystemProperties":
      return "/SystemProperties/Control";
    case "AlarmClock":
      return "/AlarmClock/Control";
  }
}

export function eventUrlForService(serviceType: ServiceType): string {
  switch (serviceType) {
    case "AVTransport":
      return "/MediaRenderer/AVTransport/Event";
    case "RenderingControl":
      return "/MediaRenderer/RenderingControl/Event";
    case "GroupRenderingControl":
      return "/MediaRenderer/GroupRenderingControl/Event";
    case "ContentDirectory":
      return "/MediaServer/ContentDirectory/Event";
    case "DeviceProperties":
      return "/DeviceProperties/Event";
    case "ZoneGroupTopology":
      return "/ZoneGroupTopology/Event";
    case "MusicServices":
      return "/MusicServices/Event";
    case "SystemProperties":
      return "/SystemProperties/Event";
    case "AlarmClock":
      return "/AlarmClock/Event";
  }
}

function additionalHeadersForService(serviceType: ServiceType): Record<string, string> {
  if (serviceType === "ContentDirectory") {
    return { "USER-AGENT": "Sonos/83.1-61210" };
  }
  return {};
}
