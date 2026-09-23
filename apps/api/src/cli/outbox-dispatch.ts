import { setTimeout as delay } from "node:timers/promises";
import { createDatabaseClient } from "../db/client.js";
import {
  OutboxDispatcher,
  outboxDispatchMode
} from "../modules/mail/reliability/outbox-dispatcher.js";
import { PrismaOutboxQueue } from "../modules/mail/reliability/prisma-outbox-queue.js";
import { FakeTransport } from "../modules/mail/reliability/outbox-transport.js";

// Intentionally no implicit .env loading, no API startup and no real transport.
// Off exits before creating a DB client. Opt in with an explicitly supplied DB.
async function main() {
  const mode = outboxDispatchMode(process.env.RELIABILITY_OUTBOX_DISPATCH_MODE);
  if (mode === "off") {
    process.stdout.write("Outbox dispatcher OFF; no database access.\n");
    return;
  }
  if (process.env.APP_ENV === "production")
    throw new Error("FAKE_PRODUCTION_FORBIDDEN");
  if (!process.env.DATABASE_URL) throw new Error("OUTBOX_DATABASE_REQUIRED");
  const database = createDatabaseClient(process.env.DATABASE_URL);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const worker = new OutboxDispatcher(
    new PrismaOutboxQueue(database),
    new FakeTransport(),
    { mode }
  );
  try {
    process.stdout.write(
      "Outbox FAKE worker; DISPATCHED is simulation completion, NOT delivery.\n"
    );
    do {
      try {
        const result = await worker.runOnce(controller.signal);
        process.stdout.write(`Outbox fake step: ${result}\n`);
      } catch {
        // No raw DB/provider exception: it may contain secrets or connection details.
        process.stderr.write(
          "OUTBOX_WORKER_DATABASE_ERROR; work retained for retry.\n"
        );
        if (process.argv.includes("--once")) process.exitCode = 1;
      }
      if (process.argv.includes("--once") || controller.signal.aborted) break;
      try {
        await delay(1_000, undefined, { signal: controller.signal });
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
  process.stderr.write("OUTBOX_WORKER_STARTUP_FAILED\n");
  process.exitCode = 1;
}
