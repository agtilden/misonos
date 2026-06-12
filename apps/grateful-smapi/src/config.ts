import { homedir } from "node:os";
import path from "node:path";

export interface SmapiConfig {
  host: string;
  port: number;
  dbPath: string;
  serviceName: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SmapiConfig {
  const defaultDb = path.join(homedir(), "Documents", "projects", "grateful", "gratefuldead.db");
  return {
    host: env.MISONOS_GRATEFUL_HOST ?? "0.0.0.0",
    port: Number.parseInt(env.MISONOS_GRATEFUL_PORT ?? "4319", 10),
    dbPath: env.MISONOS_GRATEFUL_DB ?? defaultDb,
    serviceName: env.MISONOS_GRATEFUL_NAME ?? "Grateful Dead Archive"
  };
}
