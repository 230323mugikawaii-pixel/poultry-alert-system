-- Disposable test DB ONLY: remove exactly PR05a's six added columns, no CASCADE.
ALTER TABLE mail_authorizations
  DROP COLUMN "encryptedAccessToken",
  DROP COLUMN "accessTokenExpiresAt",
  DROP COLUMN "credentialVersion",
  DROP COLUMN "refreshLeaseToken",
  DROP COLUMN "refreshLeaseUntil",
  DROP COLUMN "refreshLeaseGeneration";
