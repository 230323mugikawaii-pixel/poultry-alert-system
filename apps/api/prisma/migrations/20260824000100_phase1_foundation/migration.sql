-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'LOCKED', 'DELETED');

-- CreateEnum
CREATE TYPE "CredentialType" AS ENUM ('PASSKEY', 'PASSWORD');

-- CreateEnum
CREATE TYPE "ChallengeKind" AS ENUM ('MAGIC_LINK', 'PASSKEY_REGISTRATION', 'PASSKEY_AUTHENTICATION', 'JOIN_GRANT', 'OWNER_TRANSFER');

-- CreateEnum
CREATE TYPE "TeamStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CANCELED');

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'MEMBER');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'LEFT', 'REMOVED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELED');

-- CreateEnum
CREATE TYPE "SubscriptionChangeStatus" AS ENUM ('AWAITING_PAYMENT', 'PENDING_CAPACITY', 'APPLIED', 'CANCELED', 'FAILED');

-- CreateEnum
CREATE TYPE "InvitationKind" AS ENUM ('PASSWORD_CAPACITY');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('ACTIVE', 'EXHAUSTED', 'EXPIRED', 'REVOKED', 'REPLACED');

-- CreateEnum
CREATE TYPE "RedemptionStatus" AS ENUM ('STARTED', 'COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('WEB_PUSH', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationTargetStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "GmailConnectionStatus" AS ENUM ('ACTIVE', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "OwnerTransferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'CANCELED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "displayName" VARCHAR(120),
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "emailVerifiedAt" TIMESTAMPTZ(3),
    "lockedUntil" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_credentials" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "CredentialType" NOT NULL,
    "credentialId" VARCHAR(1024),
    "publicKey" BYTEA,
    "signCount" BIGINT DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "passwordHash" VARCHAR(255),
    "label" VARCHAR(100),
    "backupEligible" BOOLEAN DEFAULT false,
    "backupState" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "auth_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_challenges" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "kind" "ChallengeKind" NOT NULL,
    "email" VARCHAR(320),
    "secretHash" CHAR(64) NOT NULL,
    "payload" JSONB,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" VARCHAR(120),
    "userAgentHash" CHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" UUID,
    "tokenHash" CHAR(64) NOT NULL,
    "ipHash" CHAR(64),
    "userAgentHash" CHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idleExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "publicCode" CHAR(6) NOT NULL,
    "name" VARCHAR(120),
    "status" "TeamStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_memberships" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMPTZ(3),
    "removedAt" TIMESTAMPTZ(3),
    "removedByUserId" UUID,

    CONSTRAINT "team_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "seatLimit" INTEGER NOT NULL DEFAULT 0,
    "pendingSeatLimit" INTEGER,
    "currentTermAmountYen" INTEGER NOT NULL DEFAULT 6000,
    "currentTermStartedAt" TIMESTAMPTZ(3) NOT NULL,
    "currentTermEndsAt" TIMESTAMPTZ(3) NOT NULL,
    "pricingVersion" VARCHAR(32) NOT NULL DEFAULT '2026-08',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_changes" (
    "id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "requestedByUserId" UUID NOT NULL,
    "previousSeatLimit" INTEGER NOT NULL,
    "requestedSeatLimit" INTEGER NOT NULL,
    "status" "SubscriptionChangeStatus" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMPTZ(3),
    "canceledAt" TIMESTAMPTZ(3),

    CONSTRAINT "subscription_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_keywords" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "keyword" VARCHAR(100) NOT NULL,
    "normalized" VARCHAR(100) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_keywords_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "kind" "InvitationKind" NOT NULL DEFAULT 'PASSWORD_CAPACITY',
    "status" "InvitationStatus" NOT NULL DEFAULT 'ACTIVE',
    "passwordHash" VARCHAR(255) NOT NULL,
    "maxUses" INTEGER NOT NULL,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "replacedById" UUID,
    "invalidatedAt" TIMESTAMPTZ(3),
    "invalidationNote" VARCHAR(120),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation_links" (
    "id" UUID NOT NULL,
    "invitationId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'ACTIVE',
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "invalidatedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation_redemptions" (
    "id" UUID NOT NULL,
    "invitationId" UUID NOT NULL,
    "linkId" UUID,
    "userId" UUID NOT NULL,
    "membershipId" UUID,
    "status" "RedemptionStatus" NOT NULL DEFAULT 'STARTED',
    "idempotencyKey" VARCHAR(100) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "invitation_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_targets" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "deviceId" UUID,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationTargetStatus" NOT NULL DEFAULT 'ACTIVE',
    "endpointCiphertext" TEXT NOT NULL,
    "endpointHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMPTZ(3),
    "disabledAt" TIMESTAMPTZ(3),

    CONSTRAINT "notification_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gmail_connections" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "googleSubject" VARCHAR(255) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "encryptedRefreshToken" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "GmailConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "gmail_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "owner_transfers" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "targetMembershipId" UUID NOT NULL,
    "initiatedByUserId" UUID NOT NULL,
    "status" "OwnerTransferStatus" NOT NULL DEFAULT 'PENDING',
    "acceptanceTokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMPTZ(3),
    "canceledAt" TIMESTAMPTZ(3),

    CONSTRAINT "owner_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "teamId" UUID,
    "actorUserId" UUID,
    "action" VARCHAR(100) NOT NULL,
    "targetType" VARCHAR(80),
    "targetId" VARCHAR(100),
    "requestId" VARCHAR(100),
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "auth_credentials_credentialId_key" ON "auth_credentials"("credentialId");

-- CreateIndex
CREATE INDEX "auth_credentials_userId_type_idx" ON "auth_credentials"("userId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "auth_challenges_secretHash_key" ON "auth_challenges"("secretHash");

-- CreateIndex
CREATE INDEX "auth_challenges_email_kind_createdAt_idx" ON "auth_challenges"("email", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "auth_challenges_expiresAt_idx" ON "auth_challenges"("expiresAt");

-- CreateIndex
CREATE INDEX "devices_userId_revokedAt_idx" ON "devices"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_revokedAt_idx" ON "sessions"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "teams_publicCode_key" ON "teams"("publicCode");

-- CreateIndex
CREATE INDEX "team_memberships_teamId_role_status_idx" ON "team_memberships"("teamId", "role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "team_memberships_teamId_userId_key" ON "team_memberships"("teamId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_teamId_key" ON "subscriptions"("teamId");

-- CreateIndex
CREATE INDEX "subscription_changes_subscriptionId_status_idx" ON "subscription_changes"("subscriptionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "team_keywords_teamId_normalized_key" ON "team_keywords"("teamId", "normalized");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_replacedById_key" ON "invitations"("replacedById");

-- CreateIndex
CREATE INDEX "invitations_teamId_status_idx" ON "invitations"("teamId", "status");

-- CreateIndex
CREATE INDEX "invitations_expiresAt_idx" ON "invitations"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_links_tokenHash_key" ON "invitation_links"("tokenHash");

-- CreateIndex
CREATE INDEX "invitation_links_invitationId_status_idx" ON "invitation_links"("invitationId", "status");

-- CreateIndex
CREATE INDEX "invitation_links_expiresAt_idx" ON "invitation_links"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_redemptions_idempotencyKey_key" ON "invitation_redemptions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "invitation_redemptions_invitationId_status_idx" ON "invitation_redemptions"("invitationId", "status");

-- CreateIndex
CREATE INDEX "notification_targets_membershipId_status_idx" ON "notification_targets"("membershipId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "notification_targets_membershipId_channel_endpointHash_key" ON "notification_targets"("membershipId", "channel", "endpointHash");

-- CreateIndex
CREATE UNIQUE INDEX "gmail_connections_teamId_key" ON "gmail_connections"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "owner_transfers_acceptanceTokenHash_key" ON "owner_transfers"("acceptanceTokenHash");

-- CreateIndex
CREATE INDEX "owner_transfers_teamId_status_idx" ON "owner_transfers"("teamId", "status");

-- CreateIndex
CREATE INDEX "audit_events_teamId_createdAt_idx" ON "audit_events"("teamId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_events_actorUserId_createdAt_idx" ON "audit_events"("actorUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "auth_credentials" ADD CONSTRAINT "auth_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_removedByUserId_fkey" FOREIGN KEY ("removedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_changes" ADD CONSTRAINT "subscription_changes_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_changes" ADD CONSTRAINT "subscription_changes_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_keywords" ADD CONSTRAINT "team_keywords_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "invitations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation_links" ADD CONSTRAINT "invitation_links_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation_redemptions" ADD CONSTRAINT "invitation_redemptions_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "invitations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation_redemptions" ADD CONSTRAINT "invitation_redemptions_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "invitation_links"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation_redemptions" ADD CONSTRAINT "invitation_redemptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation_redemptions" ADD CONSTRAINT "invitation_redemptions_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "team_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_targets" ADD CONSTRAINT "notification_targets_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "team_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_targets" ADD CONSTRAINT "notification_targets_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gmail_connections" ADD CONSTRAINT "gmail_connections_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_transfers" ADD CONSTRAINT "owner_transfers_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_transfers" ADD CONSTRAINT "owner_transfers_targetMembershipId_fkey" FOREIGN KEY ("targetMembershipId") REFERENCES "team_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_transfers" ADD CONSTRAINT "owner_transfers_initiatedByUserId_fkey" FOREIGN KEY ("initiatedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Call Now domain invariants not expressible in Prisma schema.
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_normalized_check"
  CHECK ("email" = lower(btrim("email")));

ALTER TABLE "teams"
  ADD CONSTRAINT "teams_public_code_format_check"
  CHECK ("publicCode" ~ '^[0-9]{6}$');

ALTER TABLE "auth_challenges"
  ADD CONSTRAINT "auth_challenges_attempts_check"
  CHECK ("attemptCount" >= 0 AND "maxAttempts" > 0 AND "attemptCount" <= "maxAttempts");

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_seat_limits_check"
  CHECK (
    "seatLimit" >= 0
    AND ("pendingSeatLimit" IS NULL OR "pendingSeatLimit" >= 0)
    AND "currentTermAmountYen" >= 6000
    AND "currentTermEndsAt" > "currentTermStartedAt"
  );

ALTER TABLE "subscription_changes"
  ADD CONSTRAINT "subscription_changes_seat_limits_check"
  CHECK ("previousSeatLimit" >= 0 AND "requestedSeatLimit" >= 0);

ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_usage_check"
  CHECK ("maxUses" > 0 AND "usedCount" >= 0 AND "usedCount" <= "maxUses");

ALTER TABLE "invitation_links"
  ADD CONSTRAINT "invitation_links_usage_check"
  CHECK ("maxUses" = 1 AND "usedCount" >= 0 AND "usedCount" <= 1);

ALTER TABLE "team_memberships"
  ADD CONSTRAINT "team_memberships_status_timestamps_check"
  CHECK (
    (status = 'ACTIVE' AND "leftAt" IS NULL AND "removedAt" IS NULL)
    OR (status = 'LEFT' AND "leftAt" IS NOT NULL AND "removedAt" IS NULL)
    OR (status = 'REMOVED' AND "removedAt" IS NOT NULL)
  );

CREATE UNIQUE INDEX "team_memberships_one_active_owner_per_team"
  ON "team_memberships" ("teamId")
  WHERE role = 'OWNER' AND status = 'ACTIVE';

CREATE UNIQUE INDEX "invitations_one_active_password_per_team"
  ON "invitations" ("teamId")
  WHERE kind = 'PASSWORD_CAPACITY' AND status = 'ACTIVE';

CREATE UNIQUE INDEX "owner_transfers_one_pending_per_team"
  ON "owner_transfers" ("teamId")
  WHERE status = 'PENDING';

