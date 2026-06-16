import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SmapiConfig {
  host: string;
  port: number;
  dbPath: string;
  serviceName: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SmapiConfig {
  // Default to a sibling grateful-dead-db checkout (https://github.com/agtilden/grateful-dead-db):
  // with both repos cloned into the same parent dir, build the DB there and run misonos with no
  // copy or rename. This file lives at apps/grateful-smapi/{src,dist}/config.* — both two levels
  // below the repo root — so the repo's parent is four levels up. Override with MISONOS_GRATEFUL_DB.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const defaultDb = path.resolve(moduleDir, "../../../../grateful-dead-db/gratefuldead.db");
  return {
    host: env.MISONOS_GRATEFUL_HOST ?? "0.0.0.0",
    port: Number.parseInt(env.MISONOS_GRATEFUL_PORT ?? "4319", 10),
    dbPath: env.MISONOS_GRATEFUL_DB ?? defaultDb,
    serviceName: env.MISONOS_GRATEFUL_NAME ?? "Grateful Dead Archive"
  };
}
