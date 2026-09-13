-- Owner setup keeps delegated mail permission separate from paid team setup.
CREATE TYPE "OwnerOnboardingStatus" AS ENUM (
  'PENDING',
  'PURCHASED',
  'COMPLETED',
  'EXPIRED',
  'ABANDONED'
);

CREATE TYPE "OnboardingMailChoiceStatus" AS ENUM (
  'AUTHORIZED',
  'ACTIVATED',
  'DEFERRED',
  'SKIPPED'
);

ALTER TYPE "MailConnectionStatus" ADD VALUE 'PAUSED';

CREATE TABLE "owner_onboardings" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "teamId" UUID,
  "status" "OwnerOnboardingStatus" NOT NULL DEFAULT 'PENDING',
  "seatCount" INTEGER,
  "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "purchasedAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  "abandonedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "owner_onboardings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "onboarding_mail_choices" (
  "id" UUID NOT NULL,
  "onboardingId" UUID NOT NULL,
  "provider" "MailProvider" NOT NULL,
  "mailAuthorizationId" UUID,
  "status" "OnboardingMailChoiceStatus" NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "onboarding_mail_choices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "owner_onboardings_userId_key"
  ON "owner_onboardings"("userId");
CREATE UNIQUE INDEX "owner_onboardings_teamId_key"
  ON "owner_onboardings"("teamId");
CREATE INDEX "owner_onboardings_status_expiresAt_idx"
  ON "owner_onboardings"("status", "expiresAt");
CREATE UNIQUE INDEX "onboarding_mail_choices_onboardingId_provider_key"
  ON "onboarding_mail_choices"("onboardingId", "provider");
CREATE INDEX "onboarding_mail_choices_mailAuthorizationId_idx"
  ON "onboarding_mail_choices"("mailAuthorizationId");

ALTER TABLE "owner_onboardings"
  ADD CONSTRAINT "owner_onboardings_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "owner_onboardings"
  ADD CONSTRAINT "owner_onboardings_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "teams"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "onboarding_mail_choices"
  ADD CONSTRAINT "onboarding_mail_choices_onboardingId_fkey"
  FOREIGN KEY ("onboardingId") REFERENCES "owner_onboardings"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "onboarding_mail_choices"
  ADD CONSTRAINT "onboarding_mail_choices_mailAuthorizationId_fkey"
  FOREIGN KEY ("mailAuthorizationId") REFERENCES "mail_authorizations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
