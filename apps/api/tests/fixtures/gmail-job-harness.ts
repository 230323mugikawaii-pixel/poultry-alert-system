import { buildApp } from "../../src/app.js";
import { loadEnvironment } from "../../src/config/env.js";
import type { DatabaseClient } from "../../src/db/client.js";
import type { GmailMonitoringService } from "../../src/modules/mail/gmail/gmail-monitoring-service.js";
import { GooglePubSubPushAuthenticator } from "../../src/modules/mail/gmail/gmail-pubsub-authenticator.js";
import { PrismaGmailMonitoringRepository } from "../../src/modules/mail/gmail/prisma-gmail-monitoring-repository.js";
import type { GmailJobIntake } from "../../src/modules/mail/reliability/prisma-gmail-job-queue.js";
import {
  fixtureNow,
  ledgerHarness,
  seedLedgerFixture
} from "./mail-ledger-harness.js";

export const jobTopic = "projects/synthetic/topics/gmail-jobs";
const audience = "https://test.example/api/v1/webhooks/mail/google/pubsub";
const account = "push@synthetic.iam.gserviceaccount.com";
export const jobPath = "/api/v1/webhooks/mail/google/pubsub";
export const jobHeaders = {
  authorization: `Bearer ${"a".repeat(30)}`,
  "content-type": "application/json"
};
export const jobEnvironment = (mode: "off" | "durable" = "durable") =>
  loadEnvironment({
    APP_ENV: "test",
    LOG_LEVEL: "silent",
    PUBLIC_ORIGIN: "https://test.example",
    GMAIL_PUSH_JOB_MODE: mode,
    GMAIL_PUSH_MONITORING_ENABLED: "true",
    MAIL_LEDGER_MODE: "legacy-outbox",
    GMAIL_PUBSUB_TOPIC_NAME: jobTopic,
    GMAIL_PUBSUB_PUSH_AUDIENCE: audience,
    GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL: account
  });
export const notification = (
  emailAddress: string,
  messageId = "synthetic-push-1"
) => ({
  messageId,
  emailAddress,
  historyId: "200",
  publishTime: fixtureNow
});
export function jobEnvelope(email: string, id?: string) {
  const n = notification(email, id);
  return {
    message: {
      messageId: n.messageId,
      publishTime: n.publishTime.toISOString(),
      data: Buffer.from(
        JSON.stringify({ emailAddress: n.emailAddress, historyId: n.historyId })
      ).toString("base64")
    }
  };
}
export function jobApp(
  intake: GmailJobIntake,
  service: Pick<GmailMonitoringService, "processPushNotification">,
  mode: "off" | "durable" = "durable",
  claims: Record<string, unknown> = {}
) {
  return buildApp({
    environment: jobEnvironment(mode),
    logger: false,
    gmailJobIntake: intake,
    gmailMonitoringService: service as GmailMonitoringService,
    gmailPubSubAuthenticator: new GooglePubSubPushAuthenticator({
      audience,
      serviceAccountEmail: account,
      now: () => fixtureNow,
      verifier: {
        verify: async () => ({
          iss: "https://accounts.google.com",
          aud: audience,
          sub: "synthetic",
          exp: fixtureNow.getTime() / 1000 + 300,
          iat: fixtureNow.getTime() / 1000 - 10,
          email: account,
          email_verified: true,
          ...claims
        })
      }
    })
  });
}
export async function seedJobFixture(db: DatabaseClient) {
  const seed = await seedLedgerFixture(db);
  await db.mailAuthorization.update({
    where: { id: seed.authorization.id },
    data: {
      encryptedRefreshToken: "synthetic-encrypted-placeholder",
      encryptionProvider: "test",
      encryptionKeyVersion: "test"
    }
  });
  return seed;
}
export function jobHarness(db: DatabaseClient, connectionId: string) {
  return ledgerHarness(db, connectionId, {
    mode: "legacy-outbox",
    monitoringRepository: new PrismaGmailMonitoringRepository(db)
  });
}
export async function jobCounts(db: DatabaseClient, teamId: string) {
  return {
    ledger: await db.mailMessageLedger.count({ where: { teamId } }),
    evaluation: await db.mailEvaluation.count({
      where: { message: { teamId } }
    }),
    alert: await db.alert.count({ where: { teamId } }),
    recipient: await db.alertRecipient.count({ where: { alert: { teamId } } }),
    audit: await db.auditEvent.count({
      where: { teamId, action: "ALERT_CREATED" }
    }),
    outbox: await db.reliabilityOutbox.count({ where: { teamId } })
  };
}
