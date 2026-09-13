-- Keep multiple Google authorizations connected while allowing only one active
-- Gmail monitoring connection per team. Existing duplicate active connections
-- are paused, never revoked or deleted.

ALTER TABLE "mail_connections"
ADD COLUMN "provider" "MailProvider";

UPDATE "mail_connections" AS connection
SET "provider" = mail_authorization."provider"
FROM "mail_authorizations" AS mail_authorization
WHERE mail_authorization."id" = connection."mailAuthorizationId";

ALTER TABLE "mail_connections"
ALTER COLUMN "provider" SET NOT NULL;

ALTER TABLE "mail_connections"
DROP CONSTRAINT "mail_connections_mailAuthorizationId_fkey";

ALTER TABLE "mail_authorizations"
ADD CONSTRAINT "mail_authorizations_id_provider_key"
UNIQUE ("id", "provider");

ALTER TABLE "mail_connections"
ADD CONSTRAINT "mail_connections_mailAuthorizationId_provider_fkey"
FOREIGN KEY ("mailAuthorizationId", "provider")
REFERENCES "mail_authorizations"("id", "provider")
ON DELETE RESTRICT ON UPDATE CASCADE;

WITH ranked_google_connections AS (
  SELECT connection."id",
         ROW_NUMBER() OVER (
           PARTITION BY connection."teamId"
           ORDER BY connection."providerSubscriptionExpiresAt" DESC NULLS LAST,
                    connection."updatedAt" DESC,
                    connection."createdAt" DESC,
                    connection."id" DESC
         ) AS active_rank
  FROM "mail_connections" AS connection
  WHERE connection."provider" = 'GOOGLE'
    AND connection."status" = 'ACTIVE'
)
UPDATE "mail_connections" AS connection
SET "status" = 'PAUSED',
    "providerCursor" = NULL,
    "providerSubscriptionExpiresAt" = NULL,
    "providerSubscriptionRenewedAt" = NULL,
    "syncLeaseToken" = NULL,
    "syncLeaseExpiresAt" = NULL,
    "lastErrorCode" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
FROM ranked_google_connections AS ranked
WHERE ranked."id" = connection."id"
  AND ranked.active_rank > 1;

CREATE UNIQUE INDEX "mail_connections_one_active_google_per_team"
ON "mail_connections"("teamId")
WHERE "provider" = 'GOOGLE' AND "status" = 'ACTIVE';

CREATE INDEX "mail_connections_teamId_provider_status_idx"
ON "mail_connections"("teamId", "provider", "status");
