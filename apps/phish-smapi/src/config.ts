export interface PhishConfig {
  host: string;
  port: number;
  apiBase: string;
  apiKey?: string;
  serviceName: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PhishConfig {
  return {
    host: env.MISONOS_PHISH_HOST ?? "0.0.0.0",
    port: Number.parseInt(env.MISONOS_PHISH_PORT ?? "4320", 10),
    apiBase: (env.MISONOS_PHISH_API_BASE ?? "https://phish.in/api/v2").replace(/\/+$/, ""),
    apiKey: env.MISONOS_PHISH_API_KEY,
    serviceName: env.MISONOS_PHISH_NAME ?? "Phish.in"
  };
}
