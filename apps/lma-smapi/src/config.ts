export interface LmaConfig {
  host: string;
  port: number;
  /** Top-level archive.org collection to browse. The Live Music Archive is "etree". */
  collection: string;
  serviceName: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LmaConfig {
  return {
    host: env.MISONOS_LMA_HOST ?? "0.0.0.0",
    port: Number.parseInt(env.MISONOS_LMA_PORT ?? "4322", 10),
    collection: env.MISONOS_LMA_COLLECTION ?? "etree",
    serviceName: env.MISONOS_LMA_NAME ?? "Live Music Archive"
  };
}
