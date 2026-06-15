import { homedir } from "node:os";
import path from "node:path";

export interface BridgeConfig {
  host: string;
  port: number;
  callbackHost?: string;
  discoveryTimeoutMs: number;
  pollIntervalMs: number;
  manualSpeakerIps: string[];
  dbPath: string;
}

export function loadConfig(env = process.env): BridgeConfig {
  return {
    host: env.MISONOS_BRIDGE_HOST ?? "0.0.0.0",
    port: Number.parseInt(env.MISONOS_BRIDGE_PORT ?? "4317", 10),
    callbackHost: env.MISONOS_CALLBACK_HOST,
    discoveryTimeoutMs: Number.parseInt(env.MISONOS_DISCOVERY_TIMEOUT_MS ?? "2500", 10),
    pollIntervalMs: Number.parseInt(env.MISONOS_POLL_INTERVAL_MS ?? "2500", 10),
    manualSpeakerIps: (env.MISONOS_SPEAKER_IPS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    dbPath: env.MISONOS_BRIDGE_DB ?? path.join(homedir(), ".misonos", "misonos.db")
  };
}
