import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { SonosService } from "./sonosService.js";
import { createStore } from "./store/index.js";

const config = loadConfig();
const store = await createStore(config.dbPath); // runs migrateToLatest(); throws (fails fast) on a broken DB
const service = new SonosService(config);
const server = createServer(service, config, store);

server.listen(config.port, config.host, () => {
  console.log(`MiSonos bridge listening on http://${config.host}:${config.port}`);
  console.log(`[bridge] store: ${config.dbPath}`);
});

const shutdown = () => {
  server.close(async () => {
    await store.close();
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
