import { decodeXmlEntities, escapeXml, tagText } from "./xml.js";

export interface SoapResult {
  ok: boolean;
  values: Record<string, string>;
  fault?: {
    code?: string;
    description?: string;
  };
}

export function buildSoapEnvelope(
  serviceType: string,
  version: number,
  action: string,
  args: Record<string, unknown> = {}
): string {
  const argumentXml = Object.entries(args)
    .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
    .join("");

  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:${serviceType}:${version}">${argumentXml}</u:${action}></s:Body></s:Envelope>`;
}

export function soapActionHeader(serviceType: string, version: number, action: string): string {
  return `urn:schemas-upnp-org:service:${serviceType}:${version}#${action}`;
}

export function parseSoapResponse(xml: string): SoapResult {
  const faultDescription = tagText(xml, "errorDescription") ?? tagText(xml, "faultstring");
  if (faultDescription) {
    return {
      ok: false,
      values: {},
      fault: {
        code: tagText(xml, "errorCode"),
        description: faultDescription
      }
    };
  }

  const values: Record<string, string> = {};

  for (const match of xml.matchAll(/<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>([^<]*)<\/\1>/g)) {
    const name = match[1].split(":").at(-1);
    if (!name || name === "faultcode" || name === "faultstring") continue;
    values[name] = decodeXmlEntities(match[2].trim());
  }

  return { ok: true, values };
}
