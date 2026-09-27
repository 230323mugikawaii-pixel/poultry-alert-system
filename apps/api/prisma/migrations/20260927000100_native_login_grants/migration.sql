CREATE TABLE "native_login_grants" (
    "id" UUID NOT NULL,
    "stateHash" CHAR(64) NOT NULL,
    "bindingHash" CHAR(64) NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "clientState" VARCHAR(128) NOT NULL,
    "codeChallenge" VARCHAR(43) NOT NULL,
    "codeHash" CHAR(64),
    "userId" UUID,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "codeExpiresAt" TIMESTAMPTZ(3),
    "callbackClaimedAt" TIMESTAMPTZ(3),
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "native_login_grants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "native_login_grants_stateHash_key" ON "native_login_grants"("stateHash");
CREATE UNIQUE INDEX "native_login_grants_codeHash_key" ON "native_login_grants"("codeHash");
CREATE INDEX "native_login_grants_expiresAt_idx" ON "native_login_grants"("expiresAt");
