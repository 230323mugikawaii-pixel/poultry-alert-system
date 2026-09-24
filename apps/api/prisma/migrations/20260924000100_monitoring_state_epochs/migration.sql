-- Generated create-only with Prisma migrate diff from isolated PostgreSQL's prior 27 migrations.
CREATE TYPE "MonitorDesired" AS ENUM ('RUNNING', 'PAUSED', 'DISCONNECTED');
CREATE TYPE "MonitorObserved" AS ENUM ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'AUTH_REQUIRED', 'RECOVERING');
CREATE TYPE "IngestionOwner" AS ENUM ('LEGACY', 'LIVE');

CREATE TABLE "monitoring_states" (
    "connectionId" UUID NOT NULL,
    "desired" "MonitorDesired" NOT NULL DEFAULT 'PAUSED',
    "observed" "MonitorObserved" NOT NULL DEFAULT 'UNKNOWN',
    "ingestionOwner" "IngestionOwner" NOT NULL DEFAULT 'LEGACY',
    "shadowEnabled" BOOLEAN NOT NULL DEFAULT false,
    "generation" BIGINT NOT NULL DEFAULT 0,
    "coverageKnownFrom" TIMESTAMPTZ(3),
    "recoveryFrom" TIMESTAMPTZ(3),
    "checkedAt" TIMESTAMPTZ(3),
    "lastErrorCode" VARCHAR(100),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "monitoring_states_pkey" PRIMARY KEY ("connectionId")
);

CREATE TABLE "monitoring_epochs" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "endedAt" TIMESTAMPTZ(3),
    "boundaryCursor" TEXT,
    "keywordsSnapshot" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "matcherVersion" VARCHAR(64) NOT NULL,
    "closeReason" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "monitoring_epochs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "monitoring_states_desired_observed_idx" ON "monitoring_states"("desired", "observed");
CREATE INDEX "monitoring_epochs_connectionId_startedAt_endedAt_idx" ON "monitoring_epochs"("connectionId", "startedAt", "endedAt");
CREATE UNIQUE INDEX "monitoring_epochs_connectionId_revision_key" ON "monitoring_epochs"("connectionId", "revision");
ALTER TABLE "monitoring_states" ADD CONSTRAINT "monitoring_states_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "mail_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "monitoring_epochs" ADD CONSTRAINT "monitoring_epochs_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "mail_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Design constraints for new objects only. No old columns/data/constraints are altered.
ALTER TABLE monitoring_epochs ADD CONSTRAINT epoch_nonnegative_interval CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt");
CREATE UNIQUE INDEX monitoring_epoch_one_open ON monitoring_epochs ("connectionId") WHERE "endedAt" IS NULL;
ALTER TABLE monitoring_epochs ADD CONSTRAINT epoch_positive_revision CHECK (revision > 0);
ALTER TABLE monitoring_states ADD CONSTRAINT monitoring_generation_nonnegative CHECK (generation >= 0);
