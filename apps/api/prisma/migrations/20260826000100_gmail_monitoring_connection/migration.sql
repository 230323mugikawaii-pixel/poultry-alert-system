-- Extend OAuth challenges without changing the existing Google login flow.
ALTER TYPE "ChallengeKind" ADD VALUE 'GMAIL_OAUTH';

-- PostgreSQL does not allow a newly added enum value to be used in the same
-- migration transaction. Replace the enum type so legacy rows can be marked for
-- reauthorization safely in this migration.
CREATE TYPE "GmailConnectionStatus_new" AS ENUM (
  'ACTIVE',
  'REAUTH_REQUIRED',
  'REVOKED',
  'ERROR'
);
ALTER TABLE "gmail_connections"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "GmailConnectionStatus_new"
    USING ("status"::TEXT::"GmailConnectionStatus_new"),
  ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
DROP TYPE "GmailConnectionStatus";
ALTER TYPE "GmailConnectionStatus_new" RENAME TO "GmailConnectionStatus";

CREATE TYPE "GmailAuthorizationStatus" AS ENUM (
  'ACTIVE',
  'REAUTH_REQUIRED',
  'REVOKED',
  'ERROR'
);

CREATE TABLE "gmail_authorizations" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "provider" "IdentityProvider" NOT NULL DEFAULT 'GOOGLE',
  "providerSubject" VARCHAR(255) NOT NULL,
  "email" VARCHAR(320) NOT NULL,
  "encryptedRefreshToken" TEXT,
  "encryptionProvider" VARCHAR(40),
  "encryptionKeyVersion" VARCHAR(255),
  "grantedScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" "GmailAuthorizationStatus" NOT NULL DEFAULT 'ACTIVE',
  "lastVerifiedAt" TIMESTAMPTZ(3),
  "revokedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "gmail_authorizations_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "gmail_connections"
  ADD COLUMN "gmailAuthorizationId" UUID,
  ADD COLUMN "historyId" VARCHAR(255),
  ADD COLUMN "lastSyncAt" TIMESTAMPTZ(3),
  ADD COLUMN "lastErrorCode" VARCHAR(100);

-- Preserve any provisional Phase 1 records, but require a fresh OAuth grant
-- before they can be used. One authorization is retained per owning user and
-- can be referenced by multiple teams owned by that user.
INSERT INTO "gmail_authorizations" (
  "id",
  "userId",
  "provider",
  "providerSubject",
  "email",
  "encryptedRefreshToken",
  "encryptionProvider",
  "encryptionKeyVersion",
  "grantedScopes",
  "status",
  "lastVerifiedAt",
  "revokedAt",
  "createdAt",
  "updatedAt"
)
SELECT DISTINCT ON (membership."userId")
  gmail_connection."id",
  membership."userId",
  'GOOGLE',
  gmail_connection."googleSubject",
  gmail_connection."email",
  gmail_connection."encryptedRefreshToken",
  'LEGACY_UNKNOWN',
  'legacy',
  COALESCE(gmail_connection."scopes", ARRAY[]::TEXT[]),
  'REAUTH_REQUIRED',
  NULL,
  gmail_connection."revokedAt",
  gmail_connection."createdAt",
  gmail_connection."updatedAt"
FROM "gmail_connections" AS gmail_connection
JOIN "team_memberships" AS membership
  ON membership."teamId" = gmail_connection."teamId"
 AND membership."role" = 'OWNER'
 AND membership."status" = 'ACTIVE'
ORDER BY
  membership."userId",
  gmail_connection."createdAt",
  gmail_connection."id";

UPDATE "gmail_connections" AS gmail_connection
SET
  "gmailAuthorizationId" = gmail_authorization."id",
  "status" = 'REAUTH_REQUIRED'
FROM "team_memberships" AS membership
JOIN "gmail_authorizations" AS gmail_authorization
  ON gmail_authorization."userId" = membership."userId"
WHERE membership."teamId" = gmail_connection."teamId"
  AND membership."role" = 'OWNER'
  AND membership."status" = 'ACTIVE';

ALTER TABLE "gmail_connections"
  ALTER COLUMN "gmailAuthorizationId" SET NOT NULL,
  DROP COLUMN "googleSubject",
  DROP COLUMN "email",
  DROP COLUMN "encryptedRefreshToken",
  DROP COLUMN "scopes";

CREATE UNIQUE INDEX "gmail_authorizations_userId_key"
  ON "gmail_authorizations"("userId");
CREATE UNIQUE INDEX "gmail_authorizations_provider_providerSubject_key"
  ON "gmail_authorizations"("provider", "providerSubject");
CREATE INDEX "gmail_authorizations_status_revokedAt_idx"
  ON "gmail_authorizations"("status", "revokedAt");
CREATE INDEX "gmail_connections_gmailAuthorizationId_status_idx"
  ON "gmail_connections"("gmailAuthorizationId", "status");

ALTER TABLE "gmail_authorizations"
  ADD CONSTRAINT "gmail_authorizations_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "gmail_connections"
  ADD CONSTRAINT "gmail_connections_gmailAuthorizationId_fkey"
  FOREIGN KEY ("gmailAuthorizationId") REFERENCES "gmail_authorizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
