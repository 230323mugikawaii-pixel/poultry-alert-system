import { createDatabaseClient } from "../../src/db/client.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { atomicTestDatabase } from "./atomic-mail-test-database.js";
import { assertTestDatabase, ledgerHarness } from "./mail-ledger-harness.js";

const url = process.env.DATABASE_URL ?? "";
assertTestDatabase(url);
const database = createDatabaseClient(url);
const phase = process.env.PR02B_CRASH_PHASE;
const connectionId = process.env.PR02B_CONNECTION_ID ?? "";
const checkpoint = async (tx: Prisma.TransactionClient) => {
  const connection = await tx.mailConnection.findUniqueOrThrow({
    where: { id: connectionId }
  });
  const where = { teamId: connection.teamId };
  const counts = {
    matched: await tx.mailEvaluation.count({
      where: { connectionId, state: "MATCHED" }
    }),
    alerts: await tx.alert.count({ where }),
    recipients: await tx.alertRecipient.count({ where: { alert: where } }),
    outbox: await tx.reliabilityOutbox.count({ where }),
    audit: await tx.auditEvent.count({
      where: { ...where, action: "ALERT_CREATED" }
    })
  };
  process.send?.({ checkpoint: phase, counts });
  await new Promise<void>(() => {
    setInterval(() => undefined, 1_000);
  });
};
try {
  const instrumented = atomicTestDatabase(database, {
    ...(phase === "before-commit" ? { beforeCommit: checkpoint } : {}),
    ...(phase === "after-commit"
      ? { afterCommit: () => checkpoint(database) }
      : {})
  });
  const harness = await ledgerHarness(database, connectionId, {
    mode: "legacy-outbox",
    reliabilityDatabase: instrumented,
    message404: process.env.PR02B_RETRY_MESSAGE_MISSING === "true"
  });
  await harness.run();
  process.send?.({ completed: true, calls: harness.calls });
} catch {
  process.send?.({ failed: true });
  process.exitCode = 1;
} finally {
  await database.$disconnect();
}
