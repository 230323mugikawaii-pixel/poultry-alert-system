CREATE TYPE "ContractChangeQuoteStatus" AS ENUM ('PENDING', 'APPLIED', 'EXPIRED', 'CANCELED');

ALTER TABLE "subscriptions"
ADD COLUMN "renewalAmountYen" INTEGER;

UPDATE "subscriptions"
SET "renewalAmountYen" = "currentTermAmountYen";

ALTER TABLE "subscriptions"
ALTER COLUMN "renewalAmountYen" SET NOT NULL,
ALTER COLUMN "renewalAmountYen" SET DEFAULT 6000;

CREATE TABLE "contract_change_quotes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "teamId" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "requestedByUserId" UUID NOT NULL,
    "status" "ContractChangeQuoteStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" VARCHAR(100) NOT NULL,
    "applyIdempotencyKey" VARCHAR(100),
    "baselineFingerprint" CHAR(64) NOT NULL,
    "requestedSeatLimit" INTEGER NOT NULL,
    "requestedKeywords" TEXT[] NOT NULL,
    "requestedConnectionSettings" JSONB NOT NULL,
    "previousAnnualAmountYen" INTEGER NOT NULL,
    "nextAnnualAmountYen" INTEGER NOT NULL,
    "additionalChargeYen" INTEGER NOT NULL,
    "mailConnectionCount" INTEGER NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "appliedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "contract_change_quotes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "contract_change_quotes_amounts_check" CHECK (
      "previousAnnualAmountYen" >= 6000
      AND "nextAnnualAmountYen" >= 6000
      AND "additionalChargeYen" >= 0
    ),
    CONSTRAINT "contract_change_quotes_counts_check" CHECK (
      "requestedSeatLimit" >= 0
      AND "mailConnectionCount" >= 1
    )
);

CREATE UNIQUE INDEX "contract_change_quotes_idempotencyKey_key"
ON "contract_change_quotes"("idempotencyKey");

CREATE UNIQUE INDEX "contract_change_quotes_applyIdempotencyKey_key"
ON "contract_change_quotes"("applyIdempotencyKey");

CREATE INDEX "contract_change_quotes_teamId_status_expiresAt_idx"
ON "contract_change_quotes"("teamId", "status", "expiresAt");

CREATE INDEX "contract_change_quotes_subscriptionId_status_idx"
ON "contract_change_quotes"("subscriptionId", "status");

ALTER TABLE "contract_change_quotes"
ADD CONSTRAINT "contract_change_quotes_teamId_fkey"
FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "contract_change_quotes"
ADD CONSTRAINT "contract_change_quotes_subscriptionId_fkey"
FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "contract_change_quotes"
ADD CONSTRAINT "contract_change_quotes_requestedByUserId_fkey"
FOREIGN KEY ("requestedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
