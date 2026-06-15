import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { isConfigured } from "./podcastIndex.js";

const config = loadConfig();
const server = createServer(config);

server.listen(config.port, config.host, () => {
  console.log(`[podcast-smapi] listening on http://${config.host}:${config.port}`);
  console.log(`[podcast-smapi] search backend: ${isConfigured(config) ? "Podcast Index + iTunes fallback" : "iTunes (set PODCASTINDEX_KEY/SECRET for Podcast Index)"}`);
  console.log(`[podcast-smapi] subscriptions db: ${config.dbPath}`);
});

const shutdown = (signal: string) => {
  console.log(`[podcast-smapi] ${signal} — shutting down`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
