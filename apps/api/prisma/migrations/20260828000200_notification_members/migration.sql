CREATE TYPE "NotificationMemberStatus" AS ENUM ('ACTIVE', 'DISABLED');

CREATE TABLE "notification_members" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "callNowId" VARCHAR(16) NOT NULL,
    "displayName" VARCHAR(120),
    "passwordHash" VARCHAR(255) NOT NULL,
    "status" "NotificationMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "passwordUpdatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "disabledAt" TIMESTAMPTZ(3),

    CONSTRAINT "notification_members_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_member_sessions" (
    "id" UUID NOT NULL,
    "notificationMemberId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "ipHash" CHAR(64),
    "userAgentHash" CHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idleExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "notification_member_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_members_callNowId_key"
ON "notification_members"("callNowId");

CREATE INDEX "notification_members_teamId_status_idx"
ON "notification_members"("teamId", "status");

CREATE UNIQUE INDEX "notification_member_sessions_tokenHash_key"
ON "notification_member_sessions"("tokenHash");

CREATE INDEX "notification_member_sessions_notificationMemberId_revokedAt_idx"
ON "notification_member_sessions"("notificationMemberId", "revokedAt");

CREATE INDEX "notification_member_sessions_expiresAt_idx"
ON "notification_member_sessions"("expiresAt");

ALTER TABLE "notification_members"
ADD CONSTRAINT "notification_members_teamId_fkey"
FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_member_sessions"
ADD CONSTRAINT "notification_member_sessions_notificationMemberId_fkey"
FOREIGN KEY ("notificationMemberId") REFERENCES "notification_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
