-- Create-only equivalent: Prisma migrate diff against isolated PG17 with prior 27 migrations.
ALTER TABLE "mail_authorizations" ADD COLUMN "accessTokenExpiresAt" TIMESTAMPTZ(3),
ADD COLUMN "credentialVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "encryptedAccessToken" TEXT,
ADD COLUMN "refreshLeaseGeneration" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "refreshLeaseToken" UUID,
ADD COLUMN "refreshLeaseUntil" TIMESTAMPTZ(3);
