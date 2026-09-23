-- TEST-ONLY: only on the fresh synthetic round-trip database created by the test.
-- No CASCADE and no changes to Prisma migration history.
DROP TABLE "reliability_outbox";
DROP INDEX "alert_recipients_id_alertId_key";
DROP INDEX "alerts_id_teamId_key";
DROP TYPE "ReliabilityOutboxStatus";
DROP TYPE "ReliabilityOutboxKind";
