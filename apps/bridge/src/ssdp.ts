import dgram from "node:dgram";

export interface SsdpDevice {
  ipAddress: string;
  location: string;
  usn?: string;
  householdId?: string;
}

const PLAYER_SEARCH = [
  "M-SEARCH * HTTP/1.1",
  "HOST: 239.255.255.250:1900",
  "MAN: \"ssdp:discover\"",
  "MX: 1",
  "ST: urn:schemas-upnp-org:device:ZonePlayer:1",
  "",
  ""
].join("\r\n");

export async function discoverSsdp(timeoutMs: number, interfaceAddress?: string | null): Promise<SsdpDevice[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const devices = new Map<string, SsdpDevice>();

    const finish = () => {
      socket.removeAllListeners();
      socket.close();
      resolve([...devices.values()]);
    };

    const timer = setTimeout(finish, timeoutMs);

    socket.on("message", (message, remote) => {
      const headers = parseSsdpHeaders(message.toString("utf8"));
      const location = headers.location;
      if (!location || !/Sonos/i.test(message.toString("utf8"))) return;
      devices.set(location, {
        ipAddress: remote.address,
        location,
        usn: headers.usn,
        householdId: headers["x-rincon-household"]
      });
    });

    socket.on("error", () => {
      clearTimeout(timer);
      finish();
    });

    socket.bind(() => {
      socket.setMulticastTTL(4);
      // On a multi-homed host (e.g. with Tailscale up) the OS default multicast
      // egress can be a utun interface where no speaker hears the M-SEARCH. Pin
      // egress to the LAN interface when the caller knows it.
      if (interfaceAddress) {
        try {
          socket.setMulticastInterface(interfaceAddress);
        } catch {
          // Fall back to OS default if the address isn't a valid local iface.
        }
      }
      const payload = Buffer.from(PLAYER_SEARCH);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        socket.send(payload, 1900, "239.255.255.250");
      }
    });
  });
}

export function parseSsdpHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}
