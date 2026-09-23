CREATE TYPE "ReliabilityJobKind" AS ENUM ('SYNC');
CREATE TYPE "ReliabilityJobStatus" AS ENUM ('READY', 'RUNNING', 'RETRY_WAIT', 'BLOCKED', 'DONE');

CREATE TABLE reliability_jobs (
  id UUID NOT NULL,
  kind "ReliabilityJobKind" NOT NULL,
  status "ReliabilityJobStatus" NOT NULL DEFAULT 'READY',
  "dedupeKey" CHAR(64) NOT NULL,
  payload JSONB NOT NULL,
  "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempts INTEGER NOT NULL DEFAULT 0,
  "leaseToken" UUID,
  "leaseGeneration" BIGINT NOT NULL DEFAULT 0,
  "leaseUntil" TIMESTAMPTZ(3),
  "lastErrorCode" VARCHAR(100),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "finishedAt" TIMESTAMPTZ(3),
  CONSTRAINT reliability_jobs_pkey PRIMARY KEY (id),
  CONSTRAINT job_running_has_lease CHECK (status <> 'RUNNING' OR ("leaseToken" IS NOT NULL AND "leaseUntil" IS NOT NULL)),
  CONSTRAINT job_counters_nonnegative CHECK (attempts >= 0 AND "leaseGeneration" >= 0)
);
CREATE UNIQUE INDEX "reliability_jobs_dedupeKey_key" ON reliability_jobs ("dedupeKey");
CREATE INDEX "reliability_jobs_kind_status_availableAt_idx" ON reliability_jobs (kind, status, "availableAt");
CREATE INDEX "reliability_jobs_status_leaseUntil_idx" ON reliability_jobs (status, "leaseUntil");

-- Identifiers only; no arbitrary JSON fields, mail text, email addresses or tokens.
CREATE FUNCTION reliability_sync_payload_valid(p JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE target JSONB;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR p - ARRAY['schemaVersion','historyId','eventFingerprint','targets'] <> '{}'::jsonb
    OR p->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(p->'historyId') IS DISTINCT FROM 'string'
    OR (p->>'historyId') !~ '^[0-9]{1,64}$'
    OR jsonb_typeof(p->'eventFingerprint') IS DISTINCT FROM 'string'
    OR (p->>'eventFingerprint') !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p->'targets') IS DISTINCT FROM 'array'
  THEN RETURN FALSE; END IF;
  IF jsonb_array_length(p->'targets') > 500 THEN RETURN FALSE; END IF;
  FOR target IN SELECT value FROM jsonb_array_elements(p->'targets') LOOP
    IF jsonb_typeof(target) IS DISTINCT FROM 'object'
      OR target - ARRAY['connectionId','mailboxId','teamId'] <> '{}'::jsonb
      OR jsonb_typeof(target->'connectionId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(target->'mailboxId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(target->'teamId') IS DISTINCT FROM 'string'
      OR (target->>'connectionId') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
      OR (target->>'mailboxId') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
      OR (target->>'teamId') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    THEN RETURN FALSE; END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;
ALTER TABLE reliability_jobs ADD CONSTRAINT job_identifiers_only CHECK (reliability_sync_payload_valid(payload));
