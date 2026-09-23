-- Only PR03b objects, disposable test databases only. Never rewrite migration history.
DROP TABLE reliability_jobs;
DROP FUNCTION reliability_sync_payload_valid(JSONB);
DROP TYPE "ReliabilityJobStatus";
DROP TYPE "ReliabilityJobKind";
