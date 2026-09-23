import { createDatabaseClient } from "../../src/db/client.js";
import { PrismaOutboxQueue } from "../../src/modules/mail/reliability/prisma-outbox-queue.js";
import { OutboxDispatcher } from "../../src/modules/mail/reliability/outbox-dispatcher.js";
import type { OutboxTransport } from "../../src/modules/mail/reliability/outbox-transport.js";
import { assertTestDatabase } from "./mail-ledger-harness.js";

const url = process.env.DATABASE_URL ?? "";
assertTestDatabase(url);
if (!/^\/callnow_pr03a_test_[a-f0-9]+$/.test(new URL(url).pathname))
  throw new Error(
    "PR03a child requires its parent's newly created disposable DB"
  );
const database = createDatabaseClient(url);
const phase = process.env.PR03A_CRASH_PHASE;
const hold = async (id: string) => {
  process.send?.({ checkpoint: phase, id });
  await new Promise<void>(() => {
    setInterval(() => undefined, 1000);
  });
};
const transport: OutboxTransport = {
  mode: "fake",
  send: async (input) => {
    if (phase === "during-send") await hold(input.outboxId);
    // A durable TEST-ONLY fake receiver, not an application delivery table.
    // It models idempotency in a different process, including send-before-finish crash.
    await database.$executeRaw`
      INSERT INTO pr03a_fake_receipts ("eventKey") VALUES (${input.eventKey})
      ON CONFLICT ("eventKey") DO NOTHING
    `;
    if (phase === "after-fake") await hold(input.outboxId);
    return { kind: "FAKE_COMPLETED" };
  }
};
try {
  const result = await new OutboxDispatcher(
    new PrismaOutboxQueue(database),
    transport,
    { mode: "fake", leaseMs: 1000, timeoutMs: 900 }
  ).runOnce();
  process.send?.({ completed: true, result });
} catch {
  process.send?.({ failed: true });
  process.exitCode = 1;
} finally {
  await database.$disconnect();
}
