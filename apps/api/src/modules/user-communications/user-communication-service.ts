import { AppError } from "../../lib/app-error.js";
import type {
  FeedbackRecord,
  UserCommunicationRepository,
  UserNotificationList,
  UserNotificationRecord
} from "./user-communication-repository.js";

const MAX_FEEDBACK_LENGTH = 2_000;
const MAX_NOTIFICATION_TITLE_LENGTH = 160;
const MAX_NOTIFICATION_MESSAGE_LENGTH = 4_000;

export class UserCommunicationService {
  private readonly now: () => Date;

  public constructor(
    private readonly repository: UserCommunicationRepository,
    now?: () => Date
  ) {
    this.now = now ?? (() => new Date());
  }

  public listNotifications(userId: string): Promise<UserNotificationList> {
    return this.repository.listNotifications({ userId, limit: 50 });
  }

  public markNotificationRead(
    userId: string,
    notificationId: string
  ): Promise<UserNotificationRecord> {
    return this.repository.markNotificationRead({
      userId,
      notificationId,
      now: this.now()
    });
  }

  public submitFeedback(input: {
    readonly userId: string;
    readonly teamId?: string;
    readonly message: string;
    readonly requestId?: string;
  }): Promise<FeedbackRecord> {
    return this.repository.submitFeedback({
      userId: input.userId,
      teamId: input.teamId ?? null,
      message: normalizeText(
        input.message,
        MAX_FEEDBACK_LENGTH,
        "FEEDBACK_INVALID",
        "ご意見・フィードバックを入力してください。"
      ),
      requestId: input.requestId ?? null,
      now: this.now()
    });
  }

  /**
   * Future operator tooling can call this method after a reply is approved.
   * The repository stores the reply notification and feedback state atomically.
   */
  public recordOperatorReply(input: {
    readonly feedbackId: string;
    readonly title: string;
    readonly message: string;
    readonly requestId?: string;
  }): Promise<UserNotificationRecord> {
    return this.repository.recordFeedbackReply({
      feedbackId: input.feedbackId,
      title: normalizeText(
        input.title,
        MAX_NOTIFICATION_TITLE_LENGTH,
        "NOTIFICATION_TITLE_INVALID",
        "通知タイトルを確認してください。"
      ),
      message: normalizeText(
        input.message,
        MAX_NOTIFICATION_MESSAGE_LENGTH,
        "NOTIFICATION_MESSAGE_INVALID",
        "通知内容を確認してください。"
      ),
      requestId: input.requestId ?? null,
      now: this.now()
    });
  }
}

function normalizeText(
  value: string,
  maximumLength: number,
  code: string,
  message: string
): string {
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  const length = Array.from(normalized).length;
  if (
    length < 1 ||
    length > maximumLength ||
    Array.from(normalized).some((character) => {
      const point = character.codePointAt(0);
      return (
        point !== undefined &&
        ((point < 32 && point !== 9 && point !== 10) || point === 127)
      );
    })
  ) {
    throw new AppError(code, message, 400);
  }
  return normalized;
}
