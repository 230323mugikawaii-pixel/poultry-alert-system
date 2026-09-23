import { createDatabaseClient } from "../../src/db/client.js";
import { assertTestDatabase, ledgerHarness } from "./mail-ledger-harness.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
assertTestDatabase(databaseUrl);
const database = createDatabaseClient(databaseUrl);
const checkpoint = async () => {
  process.send?.({ checkpoint: process.env.PR01_CRASH_PHASE });
  // Parent checks committed rows through a DIFFERENT PostgreSQL connection,
  // then kills this real process. Do not throw or simulate a rollback here.
  await new Promise<void>(() => {
    setInterval(() => undefined, 1_000);
  });
};
try {
  const harness = await ledgerHarness(
    database,
    process.env.PR01_CONNECTION_ID ?? "",
    {
      ...(process.env.PR01_CRASH_PHASE === "before-fetch"
        ? { beforeFetch: checkpoint }
        : {}),
      ...(process.env.PR01_CRASH_PHASE === "after-alert-commit"
        ? { afterAlert: checkpoint }
        : {}),
      message404: process.env.PR01_RETRY_MESSAGE_MISSING === "true"
    }
  );
  await harness.run();
  process.send?.({ completed: true, calls: harness.calls });
  process.exitCode = 0;
} catch {
  // No raw provider errors or connection strings in child diagnostics.
  process.send?.({ failed: true });
  process.exitCode = 1;
} finally {
  await database.$disconnect();
}
