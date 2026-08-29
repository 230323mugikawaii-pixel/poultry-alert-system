export type UserNotificationType =
  "OPERATOR_ANNOUNCEMENT" | "SYSTEM" | "FEEDBACK_REPLY";

export interface UserNotificationRecord {
  readonly id: string;
  readonly userId: string;
  readonly feedbackId: string | null;
  readonly type: UserNotificationType;
  readonly title: string;
  readonly message: string;
  readonly createdAt: Date;
  readonly readAt: Date | null;
}

export interface FeedbackRecord {
  readonly id: string;
  readonly userId: string;
  readonly teamId: string | null;
  readonly status: "SUBMITTED" | "REPLIED" | "CLOSED";
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly repliedAt: Date | null;
}

export interface UserNotificationList {
  readonly notifications: readonly UserNotificationRecord[];
  readonly unreadCount: number;
}

export interface UserCommunicationRepository {
  listNotifications(input: {
    readonly userId: string;
    readonly limit: number;
  }): Promise<UserNotificationList>;
  markNotificationRead(input: {
    readonly userId: string;
    readonly notificationId: string;
    readonly now: Date;
  }): Promise<UserNotificationRecord>;
  submitFeedback(input: {
    readonly userId: string;
    readonly teamId: string | null;
    readonly message: string;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<FeedbackRecord>;
  recordFeedbackReply(input: {
    readonly feedbackId: string;
    readonly title: string;
    readonly message: string;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<UserNotificationRecord>;
}
