export const SMAPI_NAMESPACE = "http://www.sonos.com/Services/1.1";

export interface SoapRequest {
  action: string;
  body: string;
}

export function parseSoapRequest(xml: string): SoapRequest {
  const bodyMatch = xml.match(/<(?:[^:>\s]+:)?Body[^>]*>([\s\S]*?)<\/(?:[^:>\s]+:)?Body>/);
  if (!bodyMatch) throw new Error("SOAP envelope has no Body");
  const body = bodyMatch[1];
  const actionMatch = body.match(/<(?:[^:>\s/]+:)?([A-Za-z][A-Za-z0-9]*)\b/);
  if (!actionMatch) throw new Error("Cannot identify SOAP action");
  return { action: actionMatch[1], body };
}

export function extractTagText(body: string, tagName: string): string | undefined {
  const pattern = new RegExp(`<(?:[^:>\\s]+:)?${tagName}[^>]*>([\\s\\S]*?)</(?:[^:>\\s]+:)?${tagName}>`);
  const match = body.match(pattern);
  if (!match) return undefined;
  return decodeXmlEntities(match[1].trim());
}

export function extractTagInt(body: string, tagName: string, fallback = 0): number {
  const text = extractTagText(body, tagName);
  if (!text) return fallback;
  const parsed = Number.parseInt(text, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

export function soapResponse(action: string, innerXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body>` +
    // Default namespace (not a prefix) so child elements like getMediaURIResult
    // are namespace-qualified too — the SMAPI schema is elementFormDefault="qualified"
    // and S1 firmware silently ignores unqualified result elements.
    `<${action}Response xmlns="${SMAPI_NAMESPACE}">${innerXml}</${action}Response>` +
    `</soap:Body></soap:Envelope>`;
}

export function soapFault(faultCode: string, faultString: string, status = 500): { body: string; status: number } {
  const body = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body><soap:Fault>` +
    `<faultcode>soap:Client</faultcode>` +
    `<faultstring>${escapeXml(faultString)}</faultstring>` +
    `<detail><ExceptionInfo>${escapeXml(faultCode)}</ExceptionInfo></detail>` +
    `</soap:Fault></soap:Body></soap:Envelope>`;
  return { body, status };
}
