import { createDatabaseClient } from "../../src/db/client.js";
import { GmailJobWorker } from "../../src/modules/mail/reliability/gmail-job-worker.js";
import { PrismaGmailJobQueue } from "../../src/modules/mail/reliability/prisma-gmail-job-queue.js";
import { assertTestDatabase } from "./mail-ledger-harness.js";
import {
  jobApp,
  jobEnvelope,
  jobHeaders,
  jobPath,
  jobHarness,
  jobTopic
} from "./gmail-job-harness.js";

const value = process.env.DATABASE_URL ?? "";
assertTestDatabase(value);
if (!/^\/callnow_pr03b_test_[a-f0-9]+$/.test(new URL(value).pathname))
  throw new Error("PR03b child requires isolated DB");
const db = createDatabaseClient(value);
const phase = process.env.PR03B_PHASE;
const checkpoint = async () => {
  process.send?.({ checkpoint: phase });
  // Parent verifies committed rows using a separate connection, then sends SIGKILL.
  await new Promise<void>(() => {
    setInterval(() => undefined, 1000);
  });
};
try {
  const h = await jobHarness(db, process.env.PR03B_CONNECTION_ID ?? "");
  const queue = new PrismaGmailJobQueue(db, jobTopic);
  if (phase === "after-commit-before-ack") {
    const c = await db.mailConnection.findUniqueOrThrow({
      where: { id: process.env.PR03B_CONNECTION_ID ?? "" },
      include: { mailAuthorization: true }
    });
    const app = await jobApp(
      {
        accept: async (input) => {
          await queue.accept(input);
          await checkpoint();
        }
      },
      h.service
    );
    const response = await app.inject({
      method: "POST",
      url: jobPath,
      headers: jobHeaders,
      payload: jobEnvelope(c.mailAuthorization.email)
    });
    process.send?.({ ack: response.statusCode });
    await app.close();
  } else {
    if (phase === "after-processing-before-finish") {
      const finish = queue.finish.bind(queue);
      queue.finish = async (...args) => {
        await checkpoint();
        return finish(...args);
      };
    }
    const result = await new GmailJobWorker(
      queue,
      h.service,
      "durable",
      1000
    ).runOnce();
    process.send?.({ completed: result, calls: h.calls });
  }
} catch {
  process.send?.({ failed: true });
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
