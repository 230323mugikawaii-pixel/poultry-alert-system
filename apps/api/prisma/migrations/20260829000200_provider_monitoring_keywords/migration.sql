-- Keep onboarding keyword decisions separate per monitoring provider and
-- carry the selected set into the activated monitoring connection.
ALTER TABLE "onboarding_mail_choices"
  ADD COLUMN "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "keywordsConfirmedAt" TIMESTAMPTZ(3);

ALTER TABLE "mail_connections"
  ADD COLUMN "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
