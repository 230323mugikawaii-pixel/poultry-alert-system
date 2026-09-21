import { AppError } from "../../lib/app-error.js";
import type {
  AlertAcknowledgementResult,
  AlertIngestionResult,
  AlertKind,
  AlertRecord,
  AlertRepository,
  AlertResolutionResult,
  NotificationCenterDeletionItem,
  NotificationCenterDeletionResult
} from "./alert-repository.js";

const MAX_NOTIFICATION_DELETION_ITEMS = 100;

export interface AlertServiceOptions {
  readonly repository: AlertRepository;
  readonly now?: () => Date;
}

export class AlertService {
  private readonly now: () => Date;
  private readonly ingestionListeners = new Map<string, Set<() => void>>();

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
    return this.options.repository
      .ingest({
        ...input,
        kind: input.kind ?? "REAL",
        sourceEventId,
        matchedKeyword,
        now: this.now()
      })
      .then((result) => {
        // Wake local SSE readers only after the Alert/recipients transaction commits.
        // This is a data-free hint, not delivery: readers reauthenticate and reload.
        // Other API instances and missed hints retain the existing polling fallback.
        if (result.created) {
          for (const listener of this.ingestionListeners.get(input.teamId) ??
            []) {
            try {
              listener();
            } catch {
              // A disconnected reader must never turn a committed ingest into failure.
            }
          }
        }
        return result;
      });
  }

  public subscribeToIngestion(
    teamId: string,
    listener: () => void
  ): () => void {
    let listeners = this.ingestionListeners.get(teamId);
    if (!listeners) {
      listeners = new Set();
      this.ingestionListeners.set(teamId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (
        listeners.size === 0 &&
        this.ingestionListeners.get(teamId) === listeners
      )
        this.ingestionListeners.delete(teamId);
    };
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

  public dismissOwnerNotifications(input: {
    readonly teamId: string;
    readonly userId: string;
    readonly items: readonly NotificationCenterDeletionItem[];
    readonly requestId?: string;
  }): Promise<NotificationCenterDeletionResult> {
    const items = normalizeDeletionItems(input.items);
    return this.options.repository.dismissOwnerNotifications({
      teamId: input.teamId,
      userId: input.userId,
      items,
      requestId: input.requestId ?? null,
      now: this.now()
    });
  }

  public dismissNotificationMemberAlerts(input: {
    readonly teamId: string;
    readonly memberId: string;
    readonly alertIds: readonly string[];
    readonly requestId?: string;
  }): Promise<NotificationCenterDeletionResult> {
    const items = normalizeDeletionItems(
      input.alertIds.map((id) => ({ type: "ALERT" as const, id }))
    );
    return this.options.repository.dismissNotificationMemberAlerts({
      teamId: input.teamId,
      memberId: input.memberId,
      alertIds: items.map(({ id }) => id),
      requestId: input.requestId ?? null,
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

function normalizeDeletionItems(
  items: readonly NotificationCenterDeletionItem[]
): readonly NotificationCenterDeletionItem[] {
  if (items.length < 1 || items.length > MAX_NOTIFICATION_DELETION_ITEMS) {
    throw new AppError(
      "NOTIFICATION_DELETE_LIMIT_EXCEEDED",
      "一度に削除できるお知らせは100件までです。",
      400
    );
  }
  const unique = new Map<string, NotificationCenterDeletionItem>();
  for (const item of items) {
    unique.set(`${item.type}:${item.id}`, item);
  }
  return [...unique.values()];
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
