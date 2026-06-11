import { buildSoapEnvelope, parseSoapResponse, soapActionHeader } from "@misonos/sonos-protocol";

export type ServiceType =
  | "AVTransport"
  | "RenderingControl"
  | "GroupRenderingControl"
  | "ContentDirectory"
  | "DeviceProperties"
  | "ZoneGroupTopology";

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
      throw new SonosSoapError(
        parsed.fault?.description ?? `Sonos SOAP ${action} failed`,
        response.status,
        parsed.fault?.code
      );
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
  }
}

function additionalHeadersForService(serviceType: ServiceType): Record<string, string> {
  if (serviceType === "ContentDirectory") {
    return { "USER-AGENT": "Sonos/83.1-61210" };
  }
  return {};
}
