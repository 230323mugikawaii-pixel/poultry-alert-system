-- MailConnection keywords are the monitoring source of truth. Preserve legacy
-- team-wide keywords by copying them only into connected accounts that do not
-- yet have an account-specific set. Existing account-specific values and the
-- team-wide billing aggregate remain unchanged.

WITH legacy_team_keyword_sets AS (
  SELECT
    team_keyword."teamId",
    ARRAY_AGG(
      team_keyword."keyword"
      ORDER BY
        team_keyword."sortOrder",
        team_keyword."createdAt",
        team_keyword."id"
    )::TEXT[] AS "keywords"
  FROM "team_keywords" AS team_keyword
  GROUP BY team_keyword."teamId"
)
UPDATE "mail_connections" AS connection
SET
  "keywords" = legacy."keywords",
  "updatedAt" = CURRENT_TIMESTAMP
FROM legacy_team_keyword_sets AS legacy
WHERE connection."teamId" = legacy."teamId"
  AND connection."status" <> 'REVOKED'
  AND CARDINALITY(connection."keywords") = 0
  AND CARDINALITY(legacy."keywords") > 0;
