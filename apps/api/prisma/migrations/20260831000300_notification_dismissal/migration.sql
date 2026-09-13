ALTER TABLE "alert_recipients"
ADD COLUMN "dismissedAt" TIMESTAMPTZ(3);

ALTER TABLE "user_notifications"
ADD COLUMN "deletedAt" TIMESTAMPTZ(3);

CREATE INDEX "alert_recipients_userId_dismissedAt_readAt_createdAt_idx"
ON "alert_recipients"("userId", "dismissedAt", "readAt", "createdAt");

CREATE INDEX "alert_recipients_notificationMemberId_dismissedAt_readAt_createdAt_idx"
ON "alert_recipients"("notificationMemberId", "dismissedAt", "readAt", "createdAt");

CREATE INDEX "user_notifications_userId_deletedAt_readAt_createdAt_idx"
ON "user_notifications"("userId", "deletedAt", "readAt", "createdAt");
