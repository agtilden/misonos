export interface YtmConfig {
  host: string;
  port: number;
  serviceName: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): YtmConfig {
  return {
    host: env.MISONOS_YTM_HOST ?? "0.0.0.0",
    port: Number.parseInt(env.MISONOS_YTM_PORT ?? "4321", 10),
    serviceName: env.MISONOS_YTM_NAME ?? "YouTube Music"
  };
}
