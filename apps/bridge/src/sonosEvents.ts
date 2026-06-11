import http from "node:http";
import os from "node:os";
import type { BridgeSnapshot } from "@misonos/sonos-protocol";
import type { BridgeConfig } from "./config.js";
import { eventUrlForService } from "./sonosSoap.js";

type EventServiceType = "AVTransport" | "RenderingControl" | "ZoneGroupTopology";

interface EventSubscription {
  groupId: string;
  ipAddress: string;
  serviceType: EventServiceType;
  sid: string;
  renewTimer: NodeJS.Timeout;
}

export interface SonosNotifyEvent {
  groupId?: string;
  serviceType?: EventServiceType;
  sid?: string;
  body: string;
}

export class SonosEventManager {
  private subscriptionsByKey = new Map<string, EventSubscription>();
  private subscriptionsBySid = new Map<string, EventSubscription>();

  constructor(private readonly config: BridgeConfig) {}

  async ensureSnapshotSubscriptions(snapshot: BridgeSnapshot): Promise<void> {
    await Promise.all(
      snapshot.groups.flatMap((group) => {
        const coordinator = group.zones.find((zone) => zone.uuid === group.coordinatorId);
        if (!coordinator?.ipAddress) return [];
        return (["AVTransport", "RenderingControl", "ZoneGroupTopology"] satisfies EventServiceType[]).map(
          (serviceType) => this.ensureSubscription(group.id, coordinator.ipAddress, serviceType)
        );
      })
    );
  }

  handleNotify(headers: http.IncomingHttpHeaders, body: string): SonosNotifyEvent {
    const sid = String(headers.sid ?? "");
    const subscription = sid ? this.subscriptionsBySid.get(sid) : undefined;
    return {
      groupId: subscription?.groupId,
      serviceType: subscription?.serviceType,
      sid,
      body
    };
  }

  unsubscribeAll(): void {
    for (const subscription of this.subscriptionsByKey.values()) {
      clearTimeout(subscription.renewTimer);
      void unsubscribe(subscription.ipAddress, subscription.serviceType, subscription.sid);
    }
    this.subscriptionsByKey.clear();
    this.subscriptionsBySid.clear();
  }

  private async ensureSubscription(groupId: string, ipAddress: string, serviceType: EventServiceType): Promise<void> {
    const key = `${ipAddress}:${serviceType}`;
    const existing = this.subscriptionsByKey.get(key);
    if (existing) {
      existing.groupId = groupId;
      return;
    }

    const callbackHost = this.config.callbackHost ?? localAddressForSpeaker(ipAddress);
    if (!callbackHost) {
      throw new Error(`No LAN callback address found for Sonos event subscription to ${ipAddress}`);
    }

    const callbackUrl = `http://${callbackHost}:${this.config.port}/api/sonos-events`;
    const response = await subscribe(ipAddress, serviceType, callbackUrl);
    const sid = response.sid;
    const renewTimer = this.scheduleRenewal(key, groupId, ipAddress, serviceType, callbackUrl, response.timeoutSeconds);
    const subscription: EventSubscription = { groupId, ipAddress, serviceType, sid, renewTimer };
    this.subscriptionsByKey.set(key, subscription);
    this.subscriptionsBySid.set(sid, subscription);
  }

  private scheduleRenewal(
    key: string,
    groupId: string,
    ipAddress: string,
    serviceType: EventServiceType,
    callbackUrl: string,
    timeoutSeconds: number
  ): NodeJS.Timeout {
    const delayMs = Math.max(30_000, Math.floor(timeoutSeconds * 800));
    const timer = setTimeout(async () => {
      const current = this.subscriptionsByKey.get(key);
      if (!current) return;
      try {
        const response = await renew(ipAddress, serviceType, current.sid);
        clearTimeout(current.renewTimer);
        current.renewTimer = this.scheduleRenewal(key, groupId, ipAddress, serviceType, callbackUrl, response.timeoutSeconds);
      } catch {
        clearTimeout(current.renewTimer);
        this.subscriptionsByKey.delete(key);
        this.subscriptionsBySid.delete(current.sid);
        await this.ensureSubscription(groupId, ipAddress, serviceType);
      }
    }, delayMs);
    timer.unref();
    return timer;
  }
}

async function subscribe(
  ipAddress: string,
  serviceType: EventServiceType,
  callbackUrl: string
): Promise<{ sid: string; timeoutSeconds: number }> {
  return eventRequest(ipAddress, serviceType, {
    CALLBACK: `<${callbackUrl}>`,
    NT: "upnp:event",
    TIMEOUT: "Second-300"
  });
}

async function renew(
  ipAddress: string,
  serviceType: EventServiceType,
  sid: string
): Promise<{ sid: string; timeoutSeconds: number }> {
  return eventRequest(ipAddress, serviceType, {
    SID: sid,
    TIMEOUT: "Second-300"
  });
}

async function unsubscribe(ipAddress: string, serviceType: EventServiceType, sid: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = http.request(
      {
        host: ipAddress,
        port: 1400,
        path: eventUrlForService(serviceType),
        method: "UNSUBSCRIBE",
        headers: { SID: sid },
        timeout: 3000
      },
      (response) => {
        response.resume();
        response.on("end", resolve);
      }
    );
    request.on("error", resolve);
    request.on("timeout", () => {
      request.destroy();
      resolve();
    });
    request.end();
  });
}

async function eventRequest(
  ipAddress: string,
  serviceType: EventServiceType,
  headers: Record<string, string>
): Promise<{ sid: string; timeoutSeconds: number }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: ipAddress,
        port: 1400,
        path: eventUrlForService(serviceType),
        method: "SUBSCRIBE",
        headers,
        timeout: 5000
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          const sid = String(response.headers.sid ?? "");
          if (!sid || (response.statusCode ?? 500) >= 400) {
            reject(new Error(`Sonos event subscription failed for ${serviceType} on ${ipAddress}`));
            return;
          }
          resolve({ sid, timeoutSeconds: parseTimeoutSeconds(response.headers.timeout) });
        });
      }
    );
    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(new Error(`Sonos event subscription timed out for ${serviceType} on ${ipAddress}`));
    });
    request.end();
  });
}

function parseTimeoutSeconds(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const match = raw?.match(/Second-(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : 300;
}

export function localAddressForSpeaker(ipAddress: string): string | undefined {
  const speakerParts = ipAddress.split(".").map((part) => Number.parseInt(part, 10));
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      const localParts = address.address.split(".").map((part) => Number.parseInt(part, 10));
      if (localParts[0] === speakerParts[0] && localParts[1] === speakerParts[1] && localParts[2] === speakerParts[2]) {
        return address.address;
      }
    }
  }
  for (const addresses of Object.values(os.networkInterfaces())) {
    const address = addresses?.find((item) => item.family === "IPv4" && !item.internal);
    if (address) return address.address;
  }
  return undefined;
}
