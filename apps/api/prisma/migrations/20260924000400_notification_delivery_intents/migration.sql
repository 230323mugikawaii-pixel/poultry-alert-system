-- Create-only diff from the isolated prior-28 schema. Additive objects only.
CREATE TYPE "NotificationDeliveryState" AS ENUM ('PENDING', 'IN_FLIGHT', 'RETRY_WAIT', 'WAITING_CONFIGURATION', 'PROVIDER_ACCEPTED', 'PERMANENT_FAILURE', 'CANCELLED');
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "outboxId" UUID NOT NULL,
    "targetKey" UUID NOT NULL,
    "targetVersion" INTEGER NOT NULL,
    "state" "NotificationDeliveryState" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" UUID,
    "leaseGeneration" BIGINT NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMPTZ(3),
    "apnsRequestId" UUID,
    "acceptedAt" TIMESTAMPTZ(3),
    "lastErrorCode" VARCHAR(100),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_deliveries_counters_check" CHECK ("targetVersion">0 AND "attemptCount">=0 AND "leaseGeneration">=0)
);
CREATE INDEX "notification_deliveries_state_nextAttemptAt_idx" ON "notification_deliveries"("state", "nextAttemptAt");
CREATE UNIQUE INDEX "notification_deliveries_outboxId_targetKey_targetVersion_key" ON "notification_deliveries"("outboxId", "targetKey", "targetVersion");
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_outboxId_fkey" FOREIGN KEY ("outboxId") REFERENCES "reliability_outbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_targetKey_fkey" FOREIGN KEY ("targetKey") REFERENCES "device_push_registrations"("targetKey") ON DELETE RESTRICT ON UPDATE CASCADE;
