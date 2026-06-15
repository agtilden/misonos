import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { restoreCookies } from "./cookieAuth.js";

const config = loadConfig();
// Restore saved cookies BEFORE accepting requests, so the first browse of the
// YouTube Music root isn't served (and cached by the web) as anonymous.
await restoreCookies();
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
