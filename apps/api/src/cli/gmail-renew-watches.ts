import { config as loadDotenv } from "dotenv";
import { loadEnvironment } from "../config/env.js";
import { createDatabaseClient } from "../db/client.js";
import { AlertService } from "../modules/alerts/alert-service.js";
import { PrismaAlertRepository } from "../modules/alerts/prisma-alert-repository.js";
import { GoogleGmailApiClient } from "../modules/mail/gmail/gmail-api-client.js";
import { GmailMonitoringService } from "../modules/mail/gmail/gmail-monitoring-service.js";
import { PrismaGmailMonitoringRepository } from "../modules/mail/gmail/prisma-gmail-monitoring-repository.js";
import { GoogleMailProvider } from "../modules/mail/providers/google-mail-provider.js";
import { createTokenEncryptionProvider } from "../modules/mail/token-encryption.js";

loadDotenv({
  path: new URL("../../../../.env", import.meta.url),
  override: false,
  quiet: true
});

const environment = loadEnvironment();
if (!environment.GMAIL_PUSH_MONITORING_ENABLED) {
  throw new Error("Gmail push monitoring is not enabled");
}

const database = createDatabaseClient(environment.DATABASE_URL);
try {
  const googleProvider = new GoogleMailProvider({
    clientId: environment.GMAIL_OAUTH_CLIENT_ID,
    clientSecret: environment.GMAIL_OAUTH_CLIENT_SECRET,
    redirectUri: environment.GMAIL_OAUTH_REDIRECT_URI
  });
  const service = new GmailMonitoringService({
    repository: new PrismaGmailMonitoringRepository(database),
    api: new GoogleGmailApiClient(),
    googleProvider,
    tokenEncryption: createTokenEncryptionProvider({
      provider: environment.MAIL_TOKEN_ENCRYPTION_PROVIDER,
      localKey: environment.MAIL_TOKEN_ENCRYPTION_KEY,
      localKeyVersion: environment.MAIL_TOKEN_ENCRYPTION_KEY_VERSION,
      kmsKeyName: environment.MAIL_KMS_KEY_NAME
    }),
    alertService: new AlertService({
      repository: new PrismaAlertRepository(database)
    }),
    topicName: environment.GMAIL_PUBSUB_TOPIC_NAME,
    renewBeforeHours: environment.GMAIL_WATCH_RENEW_BEFORE_HOURS,
    historyRecoveryLookbackHours:
      environment.GMAIL_HISTORY_RECOVERY_LOOKBACK_HOURS
  });
  const result = await service.renewEligibleWatches();
  process.stdout.write(
    `Gmail watch reconciliation: attempted=${result.attempted} succeeded=${result.succeeded} busy=${result.busy} reauth=${result.reauthorizationRequired} failed=${result.failed}\n`
  );
  if (result.failed > 0) process.exitCode = 1;
} finally {
  await database.$disconnect();
}
