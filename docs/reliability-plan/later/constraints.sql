-- REVIEW BEFORE USE. Apply only in the PR that adds the corresponding tables.
-- These are database-only check/partial-index additions to a Prisma migration.
-- Do NOT run as an all-at-once production script.

ALTER TABLE mail_evaluations ADD CONSTRAINT evaluation_terminal_timestamp
CHECK (
  (state IN ('MATCHED', 'NOT_MATCHED', 'EXCLUDED')) = ("decisionAt" IS NOT NULL)
);
ALTER TABLE mail_evaluations ADD CONSTRAINT evaluation_exclusion_reason
CHECK (state <> 'EXCLUDED' OR "exclusionCode" IS NOT NULL);

ALTER TABLE monitoring_epochs ADD CONSTRAINT epoch_nonnegative_interval
CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt");
CREATE UNIQUE INDEX monitoring_epoch_one_open
ON monitoring_epochs ("connectionId") WHERE "endedAt" IS NULL;
-- Non-overlap of historical closed epochs is enforced by the writer using the
-- MonitoringState row lock plus a range overlap check in a SERIALIZABLE transaction.

CREATE UNIQUE INDEX sync_batch_one_unfinished_enumeration
ON mail_sync_batches ("streamId") WHERE "enumerationFinishedAt" IS NULL;

CREATE UNIQUE INDEX reliability_incident_one_open
ON reliability_incidents ("scopeKey", code) WHERE "resolvedAt" IS NULL;

ALTER TABLE reliability_jobs ADD CONSTRAINT job_running_has_lease
CHECK (status <> 'RUNNING' OR ("leaseToken" IS NOT NULL AND "leaseUntil" IS NOT NULL));

ALTER TABLE reliability_outbox ADD CONSTRAINT alert_outbox_has_recipient
CHECK (kind <> 'ALERT_AVAILABLE' OR
  ("teamId" IS NOT NULL AND "alertId" IS NOT NULL AND "recipientId" IS NOT NULL));

ALTER TABLE reliability_outbox ADD CONSTRAINT incident_outbox_has_incident
CHECK (kind <> 'OPERATOR_INCIDENT' OR "incidentId" IS NOT NULL);

ALTER TABLE synthetic_probes ADD CONSTRAINT positive_probe_intervals
CHECK ("intervalSeconds" > 0 AND "deadlineSeconds" > 0);
