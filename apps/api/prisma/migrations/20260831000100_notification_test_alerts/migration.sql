CREATE TYPE "AlertKind" AS ENUM ('REAL', 'TEST');
CREATE TYPE "NotificationTestStatus" AS ENUM (
  'PENDING',
  'DETECTED',
  'ALERT_CREATED',
  'EXPIRED',
  'FAILED'
);

ALTER TABLE "alerts"
ADD COLUMN "kind" "AlertKind" NOT NULL DEFAULT 'REAL';

CREATE TABLE "notification_tests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "teamId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "sourceMailConnectionId" UUID NOT NULL,
    "keyword" VARCHAR(100) NOT NULL,
    "requestId" VARCHAR(100) NOT NULL,
    "status" "NotificationTestStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "detectedAt" TIMESTAMPTZ(3),
    "alertId" UUID,
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_tests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_tests_status_check" CHECK (
      ("status" = 'PENDING' AND "detectedAt" IS NULL AND "alertId" IS NULL AND "completedAt" IS NULL)
      OR ("status" = 'DETECTED' AND "detectedAt" IS NOT NULL AND "alertId" IS NULL AND "completedAt" IS NULL)
      OR ("status" = 'ALERT_CREATED' AND "detectedAt" IS NOT NULL AND "alertId" IS NOT NULL AND "completedAt" IS NOT NULL)
      OR ("status" IN ('EXPIRED', 'FAILED') AND "alertId" IS NULL AND "completedAt" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "notification_tests_requestId_key"
ON "notification_tests"("requestId");

CREATE UNIQUE INDEX "notification_tests_alertId_key"
ON "notification_tests"("alertId");

CREATE UNIQUE INDEX "notification_tests_one_open_per_team"
ON "notification_tests"("teamId")
WHERE "status" IN ('PENDING', 'DETECTED');

CREATE INDEX "notification_tests_teamId_status_createdAt_idx"
ON "notification_tests"("teamId", "status", "createdAt");

CREATE INDEX "notification_tests_expiresAt_status_idx"
ON "notification_tests"("expiresAt", "status");

ALTER TABLE "notification_tests"
ADD CONSTRAINT "notification_tests_teamId_fkey"
FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_tests"
ADD CONSTRAINT "notification_tests_actorUserId_fkey"
FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_tests"
ADD CONSTRAINT "notification_tests_sourceMailConnectionId_fkey"
FOREIGN KEY ("sourceMailConnectionId") REFERENCES "mail_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_tests"
ADD CONSTRAINT "notification_tests_alertId_fkey"
FOREIGN KEY ("alertId") REFERENCES "alerts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
