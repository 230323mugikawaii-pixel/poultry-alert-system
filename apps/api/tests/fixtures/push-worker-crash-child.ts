import { Pool } from "pg";
import { createDatabaseClient } from "../../src/db/client.js";
import { PrismaPushDeliveryQueue } from "../../src/modules/device-push/prisma-push-delivery-queue.js";
import { PushDeliveryWorker } from "../../src/modules/device-push/push-delivery-worker.js";
import { DurableFakePushTransport } from "./push-worker-harness.js";
const url = process.env.DATABASE_URL ?? "";
let valid = false;
try {
  const u = new URL(url);
  valid =
    ["127.0.0.1", "localhost", "postgres"].includes(u.hostname) &&
    /^\/callnow_pr07b_test_[a-f0-9]+$/u.test(u.pathname);
} catch {
  /* no URL output */
}
if (!valid || process.env.PR01_TEST_ISOLATION_ACK !== "disposable-postgres")
  throw new Error("PR07B_CHILD_ISOLATION_REQUIRED");
const db = createDatabaseClient(url),
  pool = new Pool({ connectionString: url });
try {
  const transport = new DurableFakePushTransport(pool);
  const worker = new PushDeliveryWorker(
    new PrismaPushDeliveryQueue(db),
    {
      mode: "fake",
      send: async (input, signal) => {
        const result = await transport.send(input, signal);
        process.send?.({
          checkpoint: "after-fake-accept-before-finish",
          id: input.deliveryId
        });
        await new Promise<void>(() => {
          setInterval(() => undefined, 1000);
        });
        return result;
      }
    },
    { mode: "shadow", leaseMs: 2000, timeoutMs: 1500 }
  );
  await worker.runOnce();
} catch {
  process.send?.({ failed: true });
  process.exitCode = 1;
} finally {
  await db.$disconnect();
  await pool.end();
}
