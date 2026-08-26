-- Google is an external identity provider. Gmail authorization remains separate.
CREATE TYPE "IdentityProvider" AS ENUM ('GOOGLE');

ALTER TYPE "ChallengeKind" ADD VALUE 'GOOGLE_OAUTH';

CREATE TABLE "external_identities" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "IdentityProvider" NOT NULL,
    "providerSubject" VARCHAR(255) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "external_identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "external_identities_provider_providerSubject_key"
  ON "external_identities"("provider", "providerSubject");

CREATE UNIQUE INDEX "external_identities_userId_provider_key"
  ON "external_identities"("userId", "provider");

CREATE INDEX "external_identities_userId_revokedAt_idx"
  ON "external_identities"("userId", "revokedAt");

ALTER TABLE "external_identities"
  ADD CONSTRAINT "external_identities_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
