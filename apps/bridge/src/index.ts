import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { SonosService } from "./sonosService.js";

const config = loadConfig();
const service = new SonosService(config);
const server = createServer(service, config);

server.listen(config.port, config.host, () => {
  console.log(`MiSonos bridge listening on http://${config.host}:${config.port}`);
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
