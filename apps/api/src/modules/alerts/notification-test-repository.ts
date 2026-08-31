export type NotificationTestStatus =
  "PENDING" | "DETECTED" | "ALERT_CREATED" | "EXPIRED" | "FAILED";

export interface NotificationTestRecord {
  readonly id: string;
  readonly teamId: string;
  readonly actorUserId: string;
  readonly sourceMailConnectionId: string;
  readonly keyword: string;
  readonly requestId: string;
  readonly status: NotificationTestStatus;
  readonly expiresAt: Date;
  readonly detectedAt: Date | null;
  readonly alertId: string | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NotificationTestStartResult {
  readonly test: NotificationTestRecord;
  readonly created: boolean;
}

export interface NotificationTestDetectionResult {
  readonly test: NotificationTestRecord;
  readonly expired: boolean;
}

export interface NotificationTestRepository {
  start(input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly sourceMailConnectionId: string;
    readonly keyword: string;
    readonly requestId: string;
    readonly now: Date;
    readonly expiresAt: Date;
  }): Promise<NotificationTestStartResult>;
  prepareDetection(input: {
    readonly teamId: string;
    readonly testId: string;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly now: Date;
  }): Promise<NotificationTestDetectionResult>;
  markAlertCreated(input: {
    readonly teamId: string;
    readonly testId: string;
    readonly alertId: string;
    readonly now: Date;
  }): Promise<NotificationTestRecord>;
  markFailed(input: {
    readonly teamId: string;
    readonly testId: string;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly reasonCode: string;
    readonly now: Date;
  }): Promise<NotificationTestRecord>;
  markExpired(input: {
    readonly teamId: string;
    readonly testId: string;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly now: Date;
  }): Promise<NotificationTestRecord>;
  getForOwner(input: {
    readonly teamId: string;
    readonly testId: string;
    readonly actorUserId: string;
  }): Promise<NotificationTestRecord>;
  expireOpen(now: Date): Promise<number>;
}
