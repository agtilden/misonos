import { describe, expect, it } from "vitest";
import { buildSoapEnvelope, parseSoapResponse, soapActionHeader } from "../src/soap.js";

describe("soap helpers", () => {
  it("builds Sonos-compatible SOAP requests", () => {
    expect(buildSoapEnvelope("AVTransport", 1, "Play", { InstanceID: 0, Speed: 1 })).toContain(
      "<u:Play xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play>"
    );
    expect(soapActionHeader("AVTransport", 1, "Play")).toBe(
      "urn:schemas-upnp-org:service:AVTransport:1#Play"
    );
  });

  it("parses SOAP response values", () => {
    const result = parseSoapResponse(
      `<s:Envelope><s:Body><u:GetTransportInfoResponse><CurrentTransportState>PLAYING</CurrentTransportState></u:GetTransportInfoResponse></s:Body></s:Envelope>`
    );
    expect(result.ok).toBe(true);
    expect(result.values.CurrentTransportState).toBe("PLAYING");
  });

  it("parses SOAP values regardless of envelope prefix", () => {
    const result = parseSoapResponse(
      `<SOAP-ENV:Envelope><SOAP-ENV:Body><m:GetPositionInfoResponse><TrackMetaData>&lt;DIDL-Lite /&gt;</TrackMetaData><RelTime>0:01:02</RelTime></m:GetPositionInfoResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`
    );
    expect(result.values.TrackMetaData).toBe("<DIDL-Lite />");
    expect(result.values.RelTime).toBe("0:01:02");
  });
});
