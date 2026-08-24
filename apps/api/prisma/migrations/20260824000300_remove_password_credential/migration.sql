-- The initial release supports magic links and future Passkeys only.
-- Changing the enum before dropping the unused hash column makes this migration
-- fail safely if an unexpected PASSWORD credential exists.
CREATE TYPE "CredentialType_new" AS ENUM ('PASSKEY');

ALTER TABLE "auth_credentials"
  ALTER COLUMN "type" TYPE "CredentialType_new"
  USING ("type"::text::"CredentialType_new");

ALTER TYPE "CredentialType" RENAME TO "CredentialType_old";
ALTER TYPE "CredentialType_new" RENAME TO "CredentialType";
DROP TYPE "CredentialType_old";

ALTER TABLE "auth_credentials" DROP COLUMN "passwordHash";
