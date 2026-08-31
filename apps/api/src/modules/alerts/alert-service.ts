import { AppError } from "../../lib/app-error.js";
import type {
  AlertAcknowledgementResult,
  AlertIngestionResult,
  AlertKind,
  AlertRecord,
  AlertRepository,
  AlertResolutionResult
} from "./alert-repository.js";

export interface AlertServiceOptions {
  readonly repository: AlertRepository;
  readonly now?: () => Date;
}

export class AlertService {
  private readonly now: () => Date;

  public constructor(private readonly options: AlertServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public ingest(input: {
    readonly teamId: string;
    readonly sourceMailConnectionId: string;
    readonly sourceEventId: string;
    readonly kind?: AlertKind;
    readonly matchedKeyword: string;
    readonly detectedAt: Date;
    readonly actorUserId?: string;
    readonly notificationTestId?: string;
  }): Promise<AlertIngestionResult> {
    const sourceEventId = input.sourceEventId.trim();
    const matchedKeyword = normalizeMatchedKeyword(input.matchedKeyword);
    if (
      sourceEventId.length < 1 ||
      sourceEventId.length > 191 ||
      hasControlCharacter(sourceEventId)
    ) {
      throw new AppError(
        "ALERT_SOURCE_EVENT_INVALID",
        "検知イベントを登録できませんでした。",
        400
      );
    }
    if (
      Number.isNaN(input.detectedAt.getTime()) ||
      input.detectedAt.getTime() > this.now().getTime() + 300_000
    ) {
      throw new AppError(
        "ALERT_DETECTED_AT_INVALID",
        "検知時刻を確認してください。",
        400
      );
    }
    return this.options.repository.ingest({
      ...input,
      kind: input.kind ?? "REAL",
      sourceEventId,
      matchedKeyword,
      now: this.now()
    });
  }

  public listForOwner(
    teamId: string,
    userId: string
  ): Promise<readonly AlertRecord[]> {
    return this.options.repository.listForOwner({ teamId, userId, limit: 100 });
  }

  public listForNotificationMember(
    teamId: string,
    memberId: string
  ): Promise<readonly AlertRecord[]> {
    return this.options.repository.listForNotificationMember({
      teamId,
      memberId,
      limit: 100
    });
  }

  public acknowledgeByOwner(input: {
    readonly teamId: string;
    readonly alertId: string;
    readonly userId: string;
  }): Promise<AlertAcknowledgementResult> {
    return this.options.repository.acknowledgeByOwner({
      ...input,
      now: this.now()
    });
  }

  public acknowledgeByNotificationMember(input: {
    readonly teamId: string;
    readonly alertId: string;
    readonly memberId: string;
  }): Promise<AlertAcknowledgementResult> {
    return this.options.repository.acknowledgeByNotificationMember({
      ...input,
      now: this.now()
    });
  }

  public markReadByOwner(input: {
    readonly teamId: string;
    readonly alertId: string;
    readonly userId: string;
  }): Promise<AlertRecord> {
    return this.options.repository.markReadByOwner({
      ...input,
      now: this.now()
    });
  }

  public markReadByNotificationMember(input: {
    readonly teamId: string;
    readonly alertId: string;
    readonly memberId: string;
  }): Promise<AlertRecord> {
    return this.options.repository.markReadByNotificationMember({
      ...input,
      now: this.now()
    });
  }

  public resolveByOwner(input: {
    readonly teamId: string;
    readonly alertId: string;
    readonly userId: string;
  }): Promise<AlertResolutionResult> {
    return this.options.repository.resolveByOwner({
      ...input,
      now: this.now()
    });
  }
}

function normalizeMatchedKeyword(value: string): string {
  const normalized = value.trim().replace(/[ \t\u3000]+/gu, " ");
  if (
    normalized.length < 1 ||
    normalized.length > 100 ||
    hasControlCharacter(normalized)
  ) {
    throw new AppError(
      "ALERT_KEYWORD_INVALID",
      "検知キーワードを確認してください。",
      400
    );
  }
  return normalized;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}
