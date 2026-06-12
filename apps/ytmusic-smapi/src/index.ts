import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig();
const server = createServer(config);

server.listen(config.port, config.host, () => {
  console.log(`[ytmusic-smapi] listening on http://${config.host}:${config.port}`);
});

const shutdown = (signal: string) => {
  console.log(`[ytmusic-smapi] ${signal} — shutting down`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
