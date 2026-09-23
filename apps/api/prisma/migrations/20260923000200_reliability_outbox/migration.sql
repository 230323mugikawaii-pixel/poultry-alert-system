-- PR02b: append-only, record-only per-recipient outbox.
CREATE TYPE "ReliabilityOutboxKind" AS ENUM ('ALERT_AVAILABLE');
CREATE TYPE "ReliabilityOutboxStatus" AS ENUM ('PENDING', 'RUNNING', 'RETRY_WAIT', 'BLOCKED', 'DISPATCHED');

CREATE TABLE "reliability_outbox" (
    "id" UUID NOT NULL,
    "eventKey" CHAR(64) NOT NULL,
    "kind" "ReliabilityOutboxKind" NOT NULL,
    "status" "ReliabilityOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "teamId" UUID,
    "alertId" UUID,
    "recipientId" UUID,
    "payload" JSONB NOT NULL,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" UUID,
    "leaseGeneration" BIGINT NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMPTZ(3),
    "lastErrorCode" VARCHAR(100),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMPTZ(3),
    CONSTRAINT "reliability_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reliability_outbox_eventKey_key" ON "reliability_outbox"("eventKey");
CREATE INDEX "reliability_outbox_status_availableAt_idx" ON "reliability_outbox"("status", "availableAt");
CREATE INDEX "reliability_outbox_status_leaseUntil_idx" ON "reliability_outbox"("status", "leaseUntil");
CREATE INDEX "reliability_outbox_alertId_idx" ON "reliability_outbox"("alertId");

-- Additional referenced keys, not replacements for existing idempotency keys.
CREATE UNIQUE INDEX "alert_recipients_id_alertId_key" ON "alert_recipients"("id", "alertId");
CREATE UNIQUE INDEX "alerts_id_teamId_key" ON "alerts"("id", "teamId");

ALTER TABLE "reliability_outbox" ADD CONSTRAINT "reliability_outbox_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reliability_outbox" ADD CONSTRAINT "reliability_outbox_alertId_teamId_fkey" FOREIGN KEY ("alertId", "teamId") REFERENCES "alerts"("id", "teamId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reliability_outbox" ADD CONSTRAINT "reliability_outbox_recipientId_alertId_fkey" FOREIGN KEY ("recipientId", "alertId") REFERENCES "alert_recipients"("id", "alertId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reliability_outbox" ADD CONSTRAINT "alert_outbox_has_recipient"
CHECK (kind <> 'ALERT_AVAILABLE' OR
  ("teamId" IS NOT NULL AND "alertId" IS NOT NULL AND "recipientId" IS NOT NULL));

-- This stage only stores a version marker, never message text or credentials.
ALTER TABLE "reliability_outbox" ADD CONSTRAINT "outbox_safe_payload_v1"
CHECK (payload = '{"schemaVersion":1}'::jsonb);
