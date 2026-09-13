import { randomUUID } from "node:crypto";
import { AppError } from "../../src/lib/app-error.js";
import type {
  FeedbackRecord,
  UserCommunicationRepository,
  UserNotificationList,
  UserNotificationRecord
} from "../../src/modules/user-communications/user-communication-repository.js";

interface StoredFeedback extends FeedbackRecord {
  readonly message: string;
}

export class MemoryUserCommunicationRepository implements UserCommunicationRepository {
  public readonly notifications: UserNotificationRecord[] = [];
  public readonly feedback: StoredFeedback[] = [];

  public async listNotifications(input: {
    readonly userId: string;
    readonly limit: number;
  }): Promise<UserNotificationList> {
    const notifications = this.notifications
      .filter(
        (notification) =>
          notification.userId === input.userId && !notification.deletedAt
      )
      .sort(
        (first, second) =>
          second.createdAt.getTime() - first.createdAt.getTime()
      )
      .slice(0, input.limit);
    return {
      notifications,
      unreadCount: notifications.filter(({ readAt }) => !readAt).length
    };
  }

  public async markNotificationRead(input: {
    readonly userId: string;
    readonly notificationId: string;
    readonly now: Date;
  }): Promise<UserNotificationRecord> {
    const index = this.notifications.findIndex(
      (notification) =>
        notification.id === input.notificationId &&
        notification.userId === input.userId &&
        !notification.deletedAt
    );
    if (index < 0) {
      throw new AppError(
        "NOTIFICATION_NOT_FOUND",
        "通知が見つかりません。",
        404
      );
    }
    const notification = this.notifications[index]!;
    const updated = notification.readAt
      ? notification
      : { ...notification, readAt: input.now };
    this.notifications[index] = updated;
    return updated;
  }

  public async submitFeedback(input: {
    readonly userId: string;
    readonly teamId: string | null;
    readonly message: string;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<FeedbackRecord> {
    const feedback: StoredFeedback = {
      id: randomUUID(),
      userId: input.userId,
      teamId: input.teamId,
      message: input.message,
      status: "SUBMITTED",
      createdAt: input.now,
      updatedAt: input.now,
      repliedAt: null
    };
    this.feedback.push(feedback);
    return feedback;
  }

  public async recordFeedbackReply(input: {
    readonly feedbackId: string;
    readonly title: string;
    readonly message: string;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<UserNotificationRecord> {
    const feedbackIndex = this.feedback.findIndex(
      (feedback) => feedback.id === input.feedbackId
    );
    if (feedbackIndex < 0) {
      throw new AppError(
        "FEEDBACK_NOT_FOUND",
        "フィードバックが見つかりません。",
        404
      );
    }
    const existing = this.notifications.find(
      (notification) => notification.feedbackId === input.feedbackId
    );
    if (existing) return existing;
    const feedback = this.feedback[feedbackIndex]!;
    const notification: UserNotificationRecord = {
      id: randomUUID(),
      userId: feedback.userId,
      feedbackId: feedback.id,
      type: "FEEDBACK_REPLY",
      title: input.title,
      message: input.message,
      createdAt: input.now,
      readAt: null,
      deletedAt: null
    };
    this.notifications.push(notification);
    this.feedback[feedbackIndex] = {
      ...feedback,
      status: "REPLIED",
      repliedAt: input.now,
      updatedAt: input.now
    };
    return notification;
  }
}
