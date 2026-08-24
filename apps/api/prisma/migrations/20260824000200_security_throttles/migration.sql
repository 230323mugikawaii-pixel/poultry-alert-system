CREATE TABLE "security_throttles" (
    "keyHash" CHAR(64) NOT NULL,
    "scope" VARCHAR(50) NOT NULL,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMPTZ(3) NOT NULL,
    "lockedUntil" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "security_throttles_pkey" PRIMARY KEY ("keyHash"),
    CONSTRAINT "security_throttles_failure_count_check"
      CHECK ("failureCount" >= 0)
);

CREATE INDEX "security_throttles_scope_lockedUntil_idx"
  ON "security_throttles"("scope", "lockedUntil");
