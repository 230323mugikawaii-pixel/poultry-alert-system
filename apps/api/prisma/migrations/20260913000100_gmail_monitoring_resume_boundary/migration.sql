-- Record the beginning of the current monitoring interval separately from
-- lastSyncAt. A resumed Gmail connection must never recover messages that
-- arrived while the connection was paused.

ALTER TABLE "mail_connections"
ADD COLUMN "monitoringStartedAt" TIMESTAMPTZ(3);

-- Existing active Google connections have no pause/resume boundary column.
-- Prefer their latest lifecycle event that began a monitoring interval and
-- fall back to creation time. Paused and non-Google connections stay NULL.
UPDATE "mail_connections" AS connection
SET "monitoringStartedAt" = COALESCE(
  (
    SELECT MAX(event."createdAt")
    FROM "audit_events" AS event
    WHERE event."targetType" = 'MailConnection'
      AND event."targetId" = connection."id"::text
      AND event."action" IN (
        'MAIL_CONNECTED',
        'MAIL_REAUTHORIZED',
        'MAIL_MONITORING_RESUMED',
        'ONBOARDING_MAIL_MONITORING_ACTIVATED',
        'GMAIL_WATCH_STARTED'
      )
  ),
  connection."createdAt"
)
WHERE connection."provider" = 'GOOGLE'
  AND connection."status" = 'ACTIVE'
  AND connection."monitoringStartedAt" IS NULL;
