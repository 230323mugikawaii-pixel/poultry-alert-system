import { setTimeout as delay } from "node:timers/promises";
import { loadEnvironment } from "../config/env.js";
import { createDatabaseClient } from "../db/client.js";
import { AlertService } from "../modules/alerts/alert-service.js";
import { PrismaAlertRepository } from "../modules/alerts/prisma-alert-repository.js";
import { GmailMonitoringService } from "../modules/mail/gmail/gmail-monitoring-service.js";
import { PrismaGmailMonitoringRepository } from "../modules/mail/gmail/prisma-gmail-monitoring-repository.js";
import { GoogleGmailApiClient } from "../modules/mail/gmail/gmail-api-client.js";
import { GoogleMailProvider } from "../modules/mail/providers/google-mail-provider.js";
import { createTokenEncryptionProvider } from "../modules/mail/token-encryption.js";
import { mailReliabilityOptions } from "../modules/mail/reliability/mail-reliability-options.js";
import { PrismaGmailJobQueue } from "../modules/mail/reliability/prisma-gmail-job-queue.js";
import { GmailJobWorker } from "../modules/mail/reliability/gmail-job-worker.js";
import { monitoringStateReference } from "../modules/mail/reliability/monitoring-state-reference.js";

// Independent opt-in worker, no implicit .env or Outbox dispatcher startup.
async function main() {
  if ((process.env.GMAIL_PUSH_JOB_MODE ?? "off") === "off") {
    process.stdout.write(
      "Gmail job worker OFF; no database/provider access.\n"
    );
    return;
  }
  const env = loadEnvironment();
  if (!process.env.DATABASE_URL) throw new Error("GMAIL_JOB_DATABASE_REQUIRED");
  const database = createDatabaseClient(env.DATABASE_URL);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const service = new GmailMonitoringService({
      repository: new PrismaGmailMonitoringRepository(database),
      api: new GoogleGmailApiClient(),
      googleProvider: new GoogleMailProvider({
        clientId: env.GMAIL_OAUTH_CLIENT_ID,
        clientSecret: env.GMAIL_OAUTH_CLIENT_SECRET,
        redirectUri: env.GMAIL_OAUTH_REDIRECT_URI
      }),
      tokenEncryption: createTokenEncryptionProvider({
        provider: env.MAIL_TOKEN_ENCRYPTION_PROVIDER,
        localKey: env.MAIL_TOKEN_ENCRYPTION_KEY,
        localKeyVersion: env.MAIL_TOKEN_ENCRYPTION_KEY_VERSION,
        kmsKeyName: env.MAIL_KMS_KEY_NAME
      }),
      alertService: new AlertService({
        repository: new PrismaAlertRepository(database)
      }),
      ...mailReliabilityOptions(database, env.MAIL_LEDGER_MODE),
      topicName: env.GMAIL_PUBSUB_TOPIC_NAME,
      renewBeforeHours: env.GMAIL_WATCH_RENEW_BEFORE_HOURS,
      historyRecoveryLookbackHours: env.GMAIL_HISTORY_RECOVERY_LOOKBACK_HOURS
    });
    const worker = new GmailJobWorker(
      new PrismaGmailJobQueue(database, env.GMAIL_PUBSUB_TOPIC_NAME),
      service,
      env.GMAIL_PUSH_JOB_MODE,
      undefined,
      monitoringStateReference(
        database,
        env.MONITORING_STATE_MODE,
        (result) => {
          // Only state enums/generation, no addresses, identifiers, payloads or errors.
          process.stdout.write(
            `Monitoring shadow reference: ${JSON.stringify(result)}\n`
          );
        }
      )
    );
    do {
      try {
        process.stdout.write(
          `Gmail job step: ${await worker.runOnce(controller.signal)}\n`
        );
      } catch {
        process.stderr.write(
          "GMAIL_JOB_WORKER_DATABASE_ERROR; durable work retained.\n"
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
  process.stderr.write("GMAIL_JOB_WORKER_STARTUP_FAILED\n");
  process.exitCode = 1;
}
