import { buildApp } from "./app.js";
import { loadEnvironment } from "./config/env.js";

const environment = loadEnvironment();
const app = await buildApp({ environment });

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: environment.HOST, port: environment.PORT });
} catch (error) {
  app.log.fatal({ err: error }, "API startup failed");
  process.exit(1);
}

