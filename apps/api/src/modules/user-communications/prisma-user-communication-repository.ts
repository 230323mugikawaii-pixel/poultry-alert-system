import type { DatabaseClient } from "../../db/client.js";
import { AppError } from "../../lib/app-error.js";
import type {
  FeedbackRecord,
  UserCommunicationRepository,
  UserNotificationList,
  UserNotificationRecord
} from "./user-communication-repository.js";

const notificationSelect = {
  id: true,
  userId: true,
  feedbackId: true,
  type: true,
  title: true,
  message: true,
  createdAt: true,
  readAt: true,
  deletedAt: true
} as const;

const feedbackSelect = {
  id: true,
  userId: true,
  teamId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  repliedAt: true
} as const;

export class PrismaUserCommunicationRepository implements UserCommunicationRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async listNotifications(input: {
    readonly userId: string;
    readonly limit: number;
  }): Promise<UserNotificationList> {
    const [notifications, unreadCount] = await Promise.all([
      this.database.userNotification.findMany({
        where: { userId: input.userId, deletedAt: null },
        select: notificationSelect,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit
      }),
      this.database.userNotification.count({
        where: { userId: input.userId, readAt: null, deletedAt: null }
      })
    ]);
    return { notifications, unreadCount };
  }

  public async markNotificationRead(input: {
    readonly userId: string;
    readonly notificationId: string;
    readonly now: Date;
  }): Promise<UserNotificationRecord> {
    return this.database.$transaction(async (transaction) => {
      const updated = await transaction.userNotification.updateMany({
        where: {
          id: input.notificationId,
          userId: input.userId,
          readAt: null,
          deletedAt: null
        },
        data: { readAt: input.now }
      });
      const notification = await transaction.userNotification.findFirst({
        where: {
          id: input.notificationId,
          userId: input.userId,
          deletedAt: null
        },
        select: notificationSelect
      });
      if (!notification) {
        throw new AppError(
          "NOTIFICATION_NOT_FOUND",
          "通知が見つかりません。",
          404
        );
      }
      if (updated.count === 0) return notification;
      return { ...notification, readAt: input.now };
    });
  }

  public async submitFeedback(input: {
    readonly userId: string;
    readonly teamId: string | null;
    readonly message: string;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<FeedbackRecord> {
    return this.database.$transaction(async (transaction) => {
      if (input.teamId) {
        const membership = await transaction.teamMembership.findFirst({
          where: {
            teamId: input.teamId,
            userId: input.userId,
            status: "ACTIVE"
          },
          select: { id: true }
        });
        if (!membership) {
          throw new AppError(
            "TEAM_ACCESS_DENIED",
            "この操作は許可されていません。",
            403
          );
        }
      }

      const feedback = await transaction.feedbackSubmission.create({
        data: {
          userId: input.userId,
          teamId: input.teamId,
          message: input.message,
          createdAt: input.now
        },
        select: feedbackSelect
      });
      await transaction.auditEvent.create({
        data: {
          teamId: input.teamId,
          actorUserId: input.userId,
          action: "FEEDBACK_SUBMITTED",
          targetType: "FeedbackSubmission",
          targetId: feedback.id,
          requestId: input.requestId,
          metadata: { status: "SUBMITTED" }
        }
      });
      return feedback;
    });
  }

  public async recordFeedbackReply(input: {
    readonly feedbackId: string;
    readonly title: string;
    readonly message: string;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<UserNotificationRecord> {
    return this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT "id"
        FROM "feedback_submissions"
        WHERE "id" = ${input.feedbackId}::uuid
        FOR UPDATE
      `;
      const feedback = await transaction.feedbackSubmission.findUnique({
        where: { id: input.feedbackId },
        include: {
          replyNotification: { select: notificationSelect }
        }
      });
      if (!feedback) {
        throw new AppError(
          "FEEDBACK_NOT_FOUND",
          "フィードバックが見つかりません。",
          404
        );
      }
      if (feedback.replyNotification) return feedback.replyNotification;
      if (feedback.status === "CLOSED") {
        throw new AppError(
          "FEEDBACK_CLOSED",
          "このフィードバックには返信できません。",
          409
        );
      }

      const notification = await transaction.userNotification.create({
        data: {
          userId: feedback.userId,
          feedbackId: feedback.id,
          type: "FEEDBACK_REPLY",
          title: input.title,
          message: input.message,
          createdAt: input.now
        },
        select: notificationSelect
      });
      await transaction.feedbackSubmission.update({
        where: { id: feedback.id },
        data: { status: "REPLIED", repliedAt: input.now }
      });
      await transaction.auditEvent.create({
        data: {
          teamId: feedback.teamId,
          action: "FEEDBACK_REPLIED",
          targetType: "FeedbackSubmission",
          targetId: feedback.id,
          requestId: input.requestId,
          metadata: { notificationId: notification.id }
        }
      });
      return notification;
    });
  }
}
