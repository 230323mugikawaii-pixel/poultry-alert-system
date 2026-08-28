CREATE TYPE "AlertStatus" AS ENUM ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED');
CREATE TYPE "AlertRecipientKind" AS ENUM ('OWNER', 'NOTIFICATION_MEMBER');
CREATE TYPE "AlertDeliveryChannel" AS ENUM ('IN_APP');
CREATE TYPE "AlertRecipientStatus" AS ENUM ('PENDING', 'ACKNOWLEDGED', 'CLOSED');

CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "sourceMailConnectionId" UUID NOT NULL,
    "sourceEventId" VARCHAR(191) NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "detectedAt" TIMESTAMPTZ(3) NOT NULL,
    "matchedKeyword" VARCHAR(100) NOT NULL,
    "acknowledgedAt" TIMESTAMPTZ(3),
    "acknowledgedByUserId" UUID,
    "acknowledgedByNotificationMemberId" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "alerts_acknowledger_check" CHECK (
      NOT (
        "acknowledgedByUserId" IS NOT NULL
        AND "acknowledgedByNotificationMemberId" IS NOT NULL
      )
    ),
    CONSTRAINT "alerts_acknowledged_state_check" CHECK (
      "status" <> 'ACKNOWLEDGED'
      OR (
        "acknowledgedAt" IS NOT NULL
        AND (
          ("acknowledgedByUserId" IS NOT NULL AND "acknowledgedByNotificationMemberId" IS NULL)
          OR ("acknowledgedByUserId" IS NULL AND "acknowledgedByNotificationMemberId" IS NOT NULL)
        )
      )
    )
);

CREATE TABLE "alert_recipients" (
    "id" UUID NOT NULL,
    "alertId" UUID NOT NULL,
    "kind" "AlertRecipientKind" NOT NULL,
    "userId" UUID,
    "notificationMemberId" UUID,
    "channel" "AlertDeliveryChannel" NOT NULL DEFAULT 'IN_APP',
    "status" "AlertRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "acknowledgedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "alert_recipients_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "alert_recipients_actor_check" CHECK (
      ("kind" = 'OWNER' AND "userId" IS NOT NULL AND "notificationMemberId" IS NULL)
      OR
      ("kind" = 'NOTIFICATION_MEMBER' AND "userId" IS NULL AND "notificationMemberId" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "alerts_sourceMailConnectionId_sourceEventId_key"
ON "alerts"("sourceMailConnectionId", "sourceEventId");

CREATE INDEX "alerts_teamId_status_detectedAt_idx"
ON "alerts"("teamId", "status", "detectedAt");

CREATE UNIQUE INDEX "alert_recipients_alertId_userId_channel_key"
ON "alert_recipients"("alertId", "userId", "channel");

CREATE UNIQUE INDEX "alert_recipients_alertId_notificationMemberId_channel_key"
ON "alert_recipients"("alertId", "notificationMemberId", "channel");

CREATE INDEX "alert_recipients_userId_status_createdAt_idx"
ON "alert_recipients"("userId", "status", "createdAt");

CREATE INDEX "alert_recipients_notificationMemberId_status_createdAt_idx"
ON "alert_recipients"("notificationMemberId", "status", "createdAt");

ALTER TABLE "alerts"
ADD CONSTRAINT "alerts_teamId_fkey"
FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "alerts"
ADD CONSTRAINT "alerts_sourceMailConnectionId_fkey"
FOREIGN KEY ("sourceMailConnectionId") REFERENCES "mail_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "alerts"
ADD CONSTRAINT "alerts_acknowledgedByUserId_fkey"
FOREIGN KEY ("acknowledgedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "alerts"
ADD CONSTRAINT "alerts_acknowledgedByNotificationMemberId_fkey"
FOREIGN KEY ("acknowledgedByNotificationMemberId") REFERENCES "notification_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "alert_recipients"
ADD CONSTRAINT "alert_recipients_alertId_fkey"
FOREIGN KEY ("alertId") REFERENCES "alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "alert_recipients"
ADD CONSTRAINT "alert_recipients_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "alert_recipients"
ADD CONSTRAINT "alert_recipients_notificationMemberId_fkey"
FOREIGN KEY ("notificationMemberId") REFERENCES "notification_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
