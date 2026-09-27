import { createDatabaseClient } from "../db/client.js";
import { mobilePushDeliveryMode } from "../modules/device-push/mobile-delivery-planner.js";
import { PrismaPushDeliveryQueue } from "../modules/device-push/prisma-push-delivery-queue.js";
import { createPushDeliveryWorker } from "../modules/device-push/push-delivery-worker.js";
import { FakePushTransport } from "../modules/device-push/push-transport.js";
import { createConfiguredApnsTransport } from "../modules/device-push/apns-runtime.js";
import { runPushWorkerLoop } from "../modules/device-push/push-worker-loop.js";

// No implicit .env/API startup. Independent worker; real transport requires explicit apns mode.
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
  const apns =
    mode === "apns" ? createConfiguredApnsTransport(process.env) : undefined;
  const database = createDatabaseClient(process.env.DATABASE_URL);
  const worker = createPushDeliveryWorker(mode, () => ({
    queue: new PrismaPushDeliveryQueue(database),
    transport: apns?.transport ?? new FakePushTransport()
  }))!;
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    process.stdout.write(
      apns
        ? `Push APNs ${apns.environment}; PROVIDER_ACCEPTED means APNs request acceptance, NOT device display.\n`
        : "Push SHADOW/FAKE worker; PROVIDER_ACCEPTED is simulated, NOT APNs/device delivery.\n"
    );
    process.exitCode = await runPushWorkerLoop(worker, {
      signal: controller.signal,
      once: process.argv.includes("--once"),
      step: (value) =>
        process.stdout.write(`Push ${apns ? "APNs" : "FAKE"} step: ${value}\n`),
      error: (code) =>
        process.stderr.write(
          `${code}; inspect configuration/durable work before restart.\n`
        )
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    apns?.transport.close();
    await database.$disconnect();
  }
}
try {
  await main();
} catch {
  process.stderr.write("PUSH_WORKER_STARTUP_FAILED\n");
  process.exitCode = 1;
}
