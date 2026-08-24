ALTER TABLE "subscription_changes"
  ADD COLUMN "paymentEventId" VARCHAR(191),
  ADD COLUMN "issuedInvitationId" UUID;

CREATE UNIQUE INDEX "subscription_changes_paymentEventId_key"
  ON "subscription_changes"("paymentEventId");

CREATE UNIQUE INDEX "subscription_changes_issuedInvitationId_key"
  ON "subscription_changes"("issuedInvitationId");

ALTER TABLE "subscription_changes"
  ADD CONSTRAINT "subscription_changes_issuedInvitationId_fkey"
  FOREIGN KEY ("issuedInvitationId") REFERENCES "invitations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
