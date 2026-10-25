import { loadConfig, serverFromConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig();
const server = createServer(config);

server.listen(config.port, config.host, () => {
  console.log(`[navidrome-smapi] listening on http://${config.host}:${config.port}`);
  const navidrome = serverFromConfig(config);
  if (navidrome) {
    console.log(`[navidrome-smapi] server: ${navidrome.serverUrl} as ${navidrome.username}`);
    console.log(`[navidrome-smapi] non-native formats → ${config.transcodeFormat} @ ${config.maxBitRate} kbps`);
  } else {
    console.log("[navidrome-smapi] not configured — source hidden until MISONOS_NAVIDROME_SERVER_URL/_USER/_PASSWORD are set");
  }
});

const shutdown = (signal: string) => {
  console.log(`[navidrome-smapi] ${signal} — shutting down`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
