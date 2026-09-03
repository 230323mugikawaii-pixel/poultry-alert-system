ALTER TABLE "mail_connections"
  ADD COLUMN "providerSubscriptionExpiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "providerSubscriptionRenewedAt" TIMESTAMPTZ(3),
  ADD COLUMN "syncLeaseToken" VARCHAR(64),
  ADD COLUMN "syncLeaseExpiresAt" TIMESTAMPTZ(3);

CREATE INDEX "mail_connections_status_providerSubscriptionExpiresAt_idx"
  ON "mail_connections"("status", "providerSubscriptionExpiresAt");

CREATE INDEX "mail_connections_syncLeaseExpiresAt_idx"
  ON "mail_connections"("syncLeaseExpiresAt");
