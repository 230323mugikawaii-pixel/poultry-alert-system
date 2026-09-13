ALTER TABLE "contract_change_quotes"
ALTER COLUMN "id" DROP DEFAULT;

ALTER TABLE "notification_tests"
ALTER COLUMN "id" DROP DEFAULT;

ALTER INDEX "alert_recipients_notificationMemberId_dismissedAt_readAt_create"
RENAME TO "alert_recipients_member_dismissed_read_created_idx";
