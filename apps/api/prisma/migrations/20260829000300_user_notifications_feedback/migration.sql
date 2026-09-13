-- CreateEnum
CREATE TYPE "UserNotificationType" AS ENUM ('OPERATOR_ANNOUNCEMENT', 'SYSTEM', 'FEEDBACK_REPLY');

-- CreateEnum
CREATE TYPE "FeedbackStatus" AS ENUM ('SUBMITTED', 'REPLIED', 'CLOSED');

-- CreateTable
CREATE TABLE "feedback_submissions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "teamId" UUID,
    "message" TEXT NOT NULL,
    "status" "FeedbackStatus" NOT NULL DEFAULT 'SUBMITTED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "repliedAt" TIMESTAMPTZ(3),

    CONSTRAINT "feedback_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_notifications" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "feedbackId" UUID,
    "type" "UserNotificationType" NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMPTZ(3),

    CONSTRAINT "user_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feedback_submissions_userId_createdAt_idx" ON "feedback_submissions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "feedback_submissions_teamId_createdAt_idx" ON "feedback_submissions"("teamId", "createdAt");

-- CreateIndex
CREATE INDEX "feedback_submissions_status_createdAt_idx" ON "feedback_submissions"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_notifications_feedbackId_key" ON "user_notifications"("feedbackId");

-- CreateIndex
CREATE INDEX "user_notifications_userId_readAt_createdAt_idx" ON "user_notifications"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "user_notifications_userId_createdAt_idx" ON "user_notifications"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "feedback_submissions" ADD CONSTRAINT "feedback_submissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_submissions" ADD CONSTRAINT "feedback_submissions_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_notifications" ADD CONSTRAINT "user_notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_notifications" ADD CONSTRAINT "user_notifications_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "feedback_submissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
