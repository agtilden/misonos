import { homedir } from "node:os";
import path from "node:path";

export interface TuneInConfig {
  host: string;
  port: number;
  serviceName: string;
  dbPath: string;
  // TuneIn's OPML API works key-free; partnerId/serial are optional and only
  // appended when set (some partner integrations expect them).
  partnerId?: string;
  serial?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TuneInConfig {
  // Default the favorites DB next to the other MiSonos state (~/.misonos in dev,
  // /data under Docker via MISONOS_TUNEIN_DB).
  const defaultDb = path.join(homedir(), ".misonos", "tunein.db");
  return {
    host: env.MISONOS_TUNEIN_HOST ?? "0.0.0.0",
    port: Number.parseInt(env.MISONOS_TUNEIN_PORT ?? "4324", 10),
    serviceName: env.MISONOS_TUNEIN_NAME ?? "TuneIn",
    dbPath: env.MISONOS_TUNEIN_DB ?? defaultDb,
    partnerId: env.MISONOS_TUNEIN_PARTNER_ID || undefined,
    serial: env.MISONOS_TUNEIN_SERIAL || undefined
  };
}
