import { randomUUID } from "node:crypto";
import { AppError } from "../../lib/app-error.js";
import { normalizeTeamKeywords } from "../teams/keyword-policy.js";
import type { AlertService } from "./alert-service.js";
import type {
  NotificationTestRecord,
  NotificationTestRepository,
  NotificationTestStartResult
} from "./notification-test-repository.js";

const DEFAULT_TEST_TTL_MILLISECONDS = 3 * 60 * 1_000;

export interface NotificationTestServiceOptions {
  readonly repository: NotificationTestRepository;
  readonly alertService: AlertService;
  readonly now?: () => Date;
  readonly requestIdGenerator?: () => string;
  readonly ttlMilliseconds?: number;
}

export class NotificationTestService {
  private readonly now: () => Date;
  private readonly requestIdGenerator: () => string;
  private readonly ttlMilliseconds: number;

  public constructor(private readonly options: NotificationTestServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.requestIdGenerator = options.requestIdGenerator ?? randomUUID;
    this.ttlMilliseconds =
      options.ttlMilliseconds ?? DEFAULT_TEST_TTL_MILLISECONDS;
  }

  public start(input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly sourceMailConnectionId: string;
    readonly keyword: string;
  }): Promise<NotificationTestStartResult> {
    const now = this.now();
    const keyword = normalizeTeamKeywords([input.keyword])[0]!;
    return this.options.repository.start({
      ...input,
      keyword,
      requestId: this.requestIdGenerator(),
      now,
      expiresAt: new Date(now.getTime() + this.ttlMilliseconds)
    });
  }

  public async confirm(input: {
    readonly teamId: string;
    readonly testId: string;
    readonly actorUserId: string;
    readonly requestId: string;
  }): Promise<{
    readonly test: NotificationTestRecord;
    readonly created: boolean;
  }> {
    const now = this.now();
    const prepared = await this.options.repository.prepareDetection({
      ...input,
      now
    });
    if (prepared.expired) {
      throw new AppError(
        "NOTIFICATION_TEST_EXPIRED",
        "通知テストの確認期限が切れました。もう一度テストしてください。",
        410
      );
    }
    if (prepared.test.status === "ALERT_CREATED") {
      return { test: prepared.test, created: false };
    }

    const alert = await this.options.alertService.ingest({
      teamId: prepared.test.teamId,
      sourceMailConnectionId: prepared.test.sourceMailConnectionId,
      sourceEventId: `notification-test:${prepared.test.id}`,
      kind: "TEST",
      matchedKeyword: prepared.test.keyword,
      detectedAt: prepared.test.detectedAt ?? now,
      actorUserId: input.actorUserId,
      notificationTestId: prepared.test.id
    });
    const completed = await this.options.repository.markAlertCreated({
      teamId: prepared.test.teamId,
      testId: prepared.test.id,
      alertId: alert.alert.id,
      now: this.now()
    });
    return { test: completed, created: alert.created };
  }

  public markFailed(input: {
    readonly teamId: string;
    readonly testId: string;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly reasonCode: string;
  }): Promise<NotificationTestRecord> {
    return this.options.repository.markFailed({ ...input, now: this.now() });
  }

  public markExpired(input: {
    readonly teamId: string;
    readonly testId: string;
    readonly actorUserId: string;
    readonly requestId: string;
  }): Promise<NotificationTestRecord> {
    return this.options.repository.markExpired({ ...input, now: this.now() });
  }

  public getForOwner(input: {
    readonly teamId: string;
    readonly testId: string;
    readonly actorUserId: string;
  }): Promise<NotificationTestRecord> {
    return this.options.repository.getForOwner(input);
  }

  public cleanupExpired(): Promise<number> {
    return this.options.repository.expireOpen(this.now());
  }
}
