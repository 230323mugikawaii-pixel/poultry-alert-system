import { createDatabaseClient } from "../../src/db/client.js";
import { PrismaOutboxQueue } from "../../src/modules/mail/reliability/prisma-outbox-queue.js";
import { PrismaMobileDeliveryPlanner } from "../../src/modules/device-push/mobile-delivery-planner.js";
import { deliveryTxProbe } from "./delivery-test-database.js";
const url = process.env.DATABASE_URL ?? "";
let valid = false;
try {
  const parsed = new URL(url);
  valid =
    ["127.0.0.1", "localhost", "postgres"].includes(parsed.hostname) &&
    /^\/callnow_pr07a_test_[a-f0-9]+$/u.test(parsed.pathname);
} catch {
  /* no URL output */
}
if (!valid || process.env.PR01_TEST_ISOLATION_ACK !== "disposable-postgres")
  throw new Error("PR07A_CHILD_ISOLATION_REQUIRED");
const db = createDatabaseClient(url);
const phase = process.env.PR07A_CRASH_PHASE;
const hold = async (id: string, count: number) => {
  process.send?.({ checkpoint: phase, id, count });
  await new Promise<void>(() => {
    setInterval(() => undefined, 1000);
  });
};
try {
  const claim = await new PrismaOutboxQueue(db).claimOne(2000);
  if (!claim) throw new Error("PR07A_CLAIM_REQUIRED");
  const observed = deliveryTxProbe(db, {
    ...(phase === "before-commit"
      ? {
          before: async (tx) =>
            hold(
              claim.id,
              await tx.notificationDelivery.count({
                where: { outboxId: claim.id }
              })
            )
        }
      : {}),
    ...(phase === "after-commit"
      ? {
          after: async () =>
            hold(
              claim.id,
              await db.notificationDelivery.count({
                where: { outboxId: claim.id }
              })
            )
        }
      : {})
  });
  const result = await new PrismaMobileDeliveryPlanner(
    observed,
    "validated"
  ).plan(claim, new AbortController().signal);
  process.send?.({ completed: true, result });
} catch {
  process.send?.({ failed: true });
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
