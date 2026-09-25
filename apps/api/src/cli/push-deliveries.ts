import { setTimeout as delay } from "node:timers/promises";
import { createDatabaseClient } from "../db/client.js";
import { mobilePushDeliveryMode } from "../modules/device-push/mobile-delivery-planner.js";
import { PrismaPushDeliveryQueue } from "../modules/device-push/prisma-push-delivery-queue.js";
import { createPushDeliveryWorker } from "../modules/device-push/push-delivery-worker.js";
import { FakePushTransport } from "../modules/device-push/push-transport.js";

// No implicit .env/API startup/real transport. Independent worker, opt-in only.
async function main() {
  const mode = mobilePushDeliveryMode(process.env.MOBILE_PUSH_DELIVERY_MODE);
  if (mode === "off") {
    process.stdout.write(
      "Push delivery worker OFF; no database or transport access.\n"
    );
    return;
  }
  if (process.env.APP_ENV === "production")
    throw new Error("FAKE_PRODUCTION_FORBIDDEN");
  if (!process.env.DATABASE_URL) throw new Error("PUSH_DATABASE_REQUIRED");
  const database = createDatabaseClient(process.env.DATABASE_URL);
  const worker = createPushDeliveryWorker(mode, () => ({
    queue: new PrismaPushDeliveryQueue(database),
    transport: new FakePushTransport()
  }))!;
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    process.stdout.write(
      "Push SHADOW/FAKE worker; PROVIDER_ACCEPTED is simulated, NOT APNs/device delivery.\n"
    );
    do {
      try {
        process.stdout.write(
          `Push FAKE step: ${await worker.runOnce(controller.signal)}\n`
        );
      } catch {
        process.stderr.write(
          "PUSH_WORKER_DATABASE_ERROR; durable work retained.\n"
        );
        if (process.argv.includes("--once")) process.exitCode = 1;
      }
      if (process.argv.includes("--once") || controller.signal.aborted) break;
      try {
        await delay(1000, undefined, { signal: controller.signal });
      } catch {
        break;
      }
    } while (!controller.signal.aborted);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await database.$disconnect();
  }
}
try {
  await main();
} catch {
  process.stderr.write("PUSH_WORKER_STARTUP_FAILED\n");
  process.exitCode = 1;
}
