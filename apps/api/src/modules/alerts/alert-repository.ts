export type AlertStatus = "ACTIVE" | "ACKNOWLEDGED" | "RESOLVED";
export type AlertAcknowledgedBy = "OWNER" | "NOTIFICATION_MEMBER";
export type AlertMailProvider = "GOOGLE" | "MICROSOFT";

export interface AlertRecord {
  readonly id: string;
  readonly teamId: string;
  readonly sourceMailConnectionId: string;
  readonly sourceProvider: AlertMailProvider;
  readonly status: AlertStatus;
  readonly detectedAt: Date;
  readonly matchedKeyword: string;
  readonly acknowledgedAt: Date | null;
  readonly acknowledgedBy: AlertAcknowledgedBy | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly recipientCount: number;
}

export interface AlertIngestionResult {
  readonly alert: AlertRecord;
  readonly created: boolean;
}

export interface AlertAcknowledgementResult {
  readonly alert: AlertRecord;
  readonly alreadyAcknowledged: boolean;
}

export interface AlertResolutionResult {
  readonly alert: AlertRecord;
  readonly alreadyResolved: boolean;
}

export interface AlertRepository {
  ingest(input: {
    readonly teamId: string;
    readonly sourceMailConnectionId: string;
    readonly sourceEventId: string;
    readonly matchedKeyword: string;
    readonly detectedAt: Date;
    readonly now: Date;
  }): Promise<AlertIngestionResult>;
  listForOwner(input: {
    readonly teamId: string;
    readonly userId: string;
    readonly limit: number;
  }): Promise<readonly AlertRecord[]>;
  listForNotificationMember(input: {
    readonly teamId: string;
    readonly memberId: string;
    readonly limit: number;
  }): Promise<readonly AlertRecord[]>;
  acknowledgeByOwner(input: {
    readonly teamId: string;
    readonly alertId: string;
    readonly userId: string;
    readonly now: Date;
  }): Promise<AlertAcknowledgementResult>;
  acknowledgeByNotificationMember(input: {
    readonly teamId: string;
    readonly alertId: string;
    readonly memberId: string;
    readonly now: Date;
  }): Promise<AlertAcknowledgementResult>;
  resolveByOwner(input: {
    readonly teamId: string;
    readonly alertId: string;
    readonly userId: string;
    readonly now: Date;
  }): Promise<AlertResolutionResult>;
}
