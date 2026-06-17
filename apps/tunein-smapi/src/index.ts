import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig();
const server = createServer(config);

server.listen(config.port, config.host, () => {
  console.log(`[tunein-smapi] listening on http://${config.host}:${config.port}`);
  console.log(`[tunein-smapi] directory: opml.radiotime.com${config.partnerId ? ` (partnerId ${config.partnerId})` : " (key-free)"}`);
  console.log(`[tunein-smapi] favorites db: ${config.dbPath}`);
});

const shutdown = (signal: string) => {
  console.log(`[tunein-smapi] ${signal} — shutting down`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
