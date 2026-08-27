-- Preserve the Gmail foundation while generalizing monitoring authorization for
-- Gmail and Microsoft mail. Login identities continue to use IdentityProvider.
CREATE TYPE "MailProvider" AS ENUM ('GOOGLE', 'MICROSOFT');

ALTER TYPE "ChallengeKind" ADD VALUE 'MICROSOFT_MAIL_OAUTH';
ALTER TYPE "GmailAuthorizationStatus" RENAME TO "MailAuthorizationStatus";
ALTER TYPE "GmailConnectionStatus" RENAME TO "MailConnectionStatus";

ALTER TABLE "gmail_authorizations" RENAME TO "mail_authorizations";
ALTER TABLE "mail_authorizations"
  ALTER COLUMN "provider" DROP DEFAULT,
  ALTER COLUMN "provider" TYPE "MailProvider"
    USING ("provider"::TEXT::"MailProvider"),
  ALTER COLUMN "provider" SET DEFAULT 'GOOGLE';

ALTER TABLE "gmail_connections" RENAME TO "mail_connections";
ALTER TABLE "mail_connections"
  RENAME COLUMN "gmailAuthorizationId" TO "mailAuthorizationId";
ALTER TABLE "mail_connections"
  RENAME COLUMN "historyId" TO "providerCursor";
ALTER TABLE "mail_connections"
  ALTER COLUMN "providerCursor" TYPE VARCHAR(2048);

ALTER TABLE "mail_authorizations"
  RENAME CONSTRAINT "gmail_authorizations_pkey" TO "mail_authorizations_pkey";
ALTER TABLE "mail_authorizations"
  RENAME CONSTRAINT "gmail_authorizations_userId_fkey" TO "mail_authorizations_userId_fkey";
ALTER TABLE "mail_connections"
  RENAME CONSTRAINT "gmail_connections_pkey" TO "mail_connections_pkey";
ALTER TABLE "mail_connections"
  RENAME CONSTRAINT "gmail_connections_teamId_fkey" TO "mail_connections_teamId_fkey";
ALTER TABLE "mail_connections"
  RENAME CONSTRAINT "gmail_connections_gmailAuthorizationId_fkey" TO "mail_connections_mailAuthorizationId_fkey";

ALTER INDEX "gmail_authorizations_userId_key"
  RENAME TO "mail_authorizations_userId_key";
ALTER INDEX "gmail_authorizations_provider_providerSubject_key"
  RENAME TO "mail_authorizations_provider_providerSubject_key";
ALTER INDEX "gmail_authorizations_status_revokedAt_idx"
  RENAME TO "mail_authorizations_status_revokedAt_idx";
ALTER INDEX "gmail_connections_teamId_key"
  RENAME TO "mail_connections_teamId_key";
ALTER INDEX "gmail_connections_gmailAuthorizationId_status_idx"
  RENAME TO "mail_connections_mailAuthorizationId_status_idx";
