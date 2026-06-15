import { homedir } from "node:os";
import path from "node:path";

export interface PodcastConfig {
  host: string;
  port: number;
  serviceName: string;
  dbPath: string;
  podcastIndexKey?: string;
  podcastIndexSecret?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PodcastConfig {
  // Default the subscriptions DB next to the other MiSonos state (~/.misonos in dev,
  // /data under Docker via MISONOS_PODCAST_DB).
  const defaultDb = path.join(homedir(), ".misonos", "podcasts.db");
  return {
    host: env.MISONOS_PODCAST_HOST ?? "0.0.0.0",
    port: Number.parseInt(env.MISONOS_PODCAST_PORT ?? "4323", 10),
    serviceName: env.MISONOS_PODCAST_NAME ?? "Podcasts",
    dbPath: env.MISONOS_PODCAST_DB ?? defaultDb,
    podcastIndexKey: env.PODCASTINDEX_KEY || undefined,
    podcastIndexSecret: env.PODCASTINDEX_SECRET || undefined
  };
}
