ALTER TABLE "alert_recipients"
ADD COLUMN "readAt" TIMESTAMPTZ(3);

CREATE INDEX "alert_recipients_userId_readAt_createdAt_idx"
ON "alert_recipients"("userId", "readAt", "createdAt");

CREATE INDEX "alert_recipients_notificationMemberId_readAt_createdAt_idx"
ON "alert_recipients"("notificationMemberId", "readAt", "createdAt");
