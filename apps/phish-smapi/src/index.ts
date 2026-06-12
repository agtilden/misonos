import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig();
const server = createServer(config);

server.listen(config.port, config.host, () => {
  console.log(`[phish-smapi] listening on http://${config.host}:${config.port}`);
  console.log(`[phish-smapi] phish.in api: ${config.apiBase}${config.apiKey ? " (with bearer token)" : ""}`);
});

const shutdown = (signal: string) => {
  console.log(`[phish-smapi] ${signal} — shutting down`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
