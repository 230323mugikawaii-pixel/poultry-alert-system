-- Permit one owner to authorize multiple monitoring accounts and one team to
-- monitor multiple independently revocable accounts. Existing rows are kept.
DROP INDEX IF EXISTS "mail_authorizations_userId_key";
DROP INDEX IF EXISTS "mail_connections_teamId_key";

CREATE INDEX "mail_authorizations_userId_status_revokedAt_idx"
  ON "mail_authorizations"("userId", "status", "revokedAt");

CREATE UNIQUE INDEX "mail_connections_teamId_mailAuthorizationId_key"
  ON "mail_connections"("teamId", "mailAuthorizationId");

CREATE INDEX "mail_connections_teamId_status_idx"
  ON "mail_connections"("teamId", "status");
