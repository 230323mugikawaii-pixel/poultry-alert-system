-- CreateEnum
CREATE TYPE "ReliabilityLane" AS ENUM ('LEGACY');

-- CreateEnum
CREATE TYPE "MailEvaluationState" AS ENUM ('DISCOVERED', 'FETCH_PENDING', 'EVALUATING', 'MATCHED', 'NOT_MATCHED', 'EXCLUDED', 'UNDETERMINED');

-- CreateTable
CREATE TABLE "mail_message_ledger" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "provider" "MailProvider" NOT NULL,
    "mailboxId" UUID NOT NULL,
    "firstConnectionId" UUID NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "messageKey" CHAR(64) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3),
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "alertId" UUID,

    CONSTRAINT "mail_message_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_evaluations" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "lane" "ReliabilityLane" NOT NULL,
    "state" "MailEvaluationState" NOT NULL DEFAULT 'DISCOVERED',
    "keywordsSnapshot" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ruleHash" CHAR(64) NOT NULL,
    "matcherVersion" VARCHAR(64) NOT NULL,
    "matchedKeyword" VARCHAR(100),
    "exclusionCode" VARCHAR(64),
    "lastErrorCode" VARCHAR(100),
    "unresolvedSince" TIMESTAMPTZ(3),
    "decisionAt" TIMESTAMPTZ(3),
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mail_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mail_message_ledger_messageKey_key" ON "mail_message_ledger"("messageKey");

-- CreateIndex
CREATE UNIQUE INDEX "mail_message_ledger_alertId_key" ON "mail_message_ledger"("alertId");

-- CreateIndex
CREATE INDEX "mail_message_ledger_teamId_mailboxId_receivedAt_idx" ON "mail_message_ledger"("teamId", "mailboxId", "receivedAt");

-- CreateIndex
CREATE INDEX "mail_message_ledger_mailboxId_firstSeenAt_idx" ON "mail_message_ledger"("mailboxId", "firstSeenAt");

-- CreateIndex
CREATE INDEX "mail_evaluations_connectionId_lane_state_createdAt_idx" ON "mail_evaluations"("connectionId", "lane", "state", "createdAt");

-- CreateIndex
CREATE INDEX "mail_evaluations_state_unresolvedSince_idx" ON "mail_evaluations"("state", "unresolvedSince");

-- CreateIndex
CREATE UNIQUE INDEX "mail_evaluations_messageId_lane_key" ON "mail_evaluations"("messageId", "lane");

-- AddForeignKey
ALTER TABLE "mail_message_ledger" ADD CONSTRAINT "mail_message_ledger_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_message_ledger" ADD CONSTRAINT "mail_message_ledger_mailboxId_provider_fkey" FOREIGN KEY ("mailboxId", "provider") REFERENCES "mail_authorizations"("id", "provider") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_message_ledger" ADD CONSTRAINT "mail_message_ledger_firstConnectionId_fkey" FOREIGN KEY ("firstConnectionId") REFERENCES "mail_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_message_ledger" ADD CONSTRAINT "mail_message_ledger_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "alerts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_evaluations" ADD CONSTRAINT "mail_evaluations_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "mail_message_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_evaluations" ADD CONSTRAINT "mail_evaluations_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "mail_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
