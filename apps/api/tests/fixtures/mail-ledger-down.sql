-- TEST-ONLY rollback, only on the disposable PR01 migration test database.
-- Does NOT alter Prisma migration history. Never run on an application DB.
BEGIN;
DROP TABLE "mail_evaluations";
DROP TABLE "mail_message_ledger";
DROP TYPE "MailEvaluationState";
DROP TYPE "ReliabilityLane";
COMMIT;
