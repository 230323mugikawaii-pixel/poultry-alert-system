ALTER TABLE "notification_members"
ADD COLUMN "deletedAt" TIMESTAMPTZ(3);

CREATE INDEX "notification_members_teamId_deletedAt_idx"
ON "notification_members"("teamId", "deletedAt");

ALTER TABLE "team_keywords"
ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

WITH ranked_keywords AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "teamId"
      ORDER BY "createdAt", "id"
    ) - 1 AS "sortOrder"
  FROM "team_keywords"
)
UPDATE "team_keywords" AS keyword
SET "sortOrder" = ranked_keywords."sortOrder"
FROM ranked_keywords
WHERE keyword."id" = ranked_keywords."id";

CREATE INDEX "team_keywords_teamId_sortOrder_idx"
ON "team_keywords"("teamId", "sortOrder");
