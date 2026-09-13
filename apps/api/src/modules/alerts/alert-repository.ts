export type AlertStatus = "ACTIVE" | "ACKNOWLEDGED" | "RESOLVED";
export type AlertKind = "REAL" | "TEST";
export type AlertAcknowledgedBy = "OWNER" | "NOTIFICATION_MEMBER";
export type AlertMailProvider = "GOOGLE" | "MICROSOFT";

export interface AlertRecord {
  readonly id: string;
  readonly teamId: string;
  readonly sourceMailConnectionId: string;
  readonly sourceProvider: AlertMailProvider;
  readonly kind: AlertKind;
  readonly status: AlertStatus;
  readonly detectedAt: Date;
  readonly matchedKeyword: string;
  readonly acknowledgedAt: Date | null;
  readonly acknowledgedBy: AlertAcknowledgedBy | null;
  readonly acknowledgedByName: string | null;
  readonly readAt: Date | null;
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

export type NotificationCenterItemType = "ALERT" | "USER_NOTIFICATION";

export interface NotificationCenterDeletionItem {
  readonly type: NotificationCenterItemType;
  readonly id: string;
}

export interface NotificationCenterDeletionResult {
  readonly items: readonly NotificationCenterDeletionItem[];
  readonly deletedCount: number;
  readonly alreadyDeletedCount: number;
}

export interface AlertRepository {
  ingest(input: {
    readonly teamId: string;
    readonly sourceMailConnectionId: string;
    readonly sourceEventId: string;
    readonly kind: AlertKind;
    readonly matchedKeyword: string;
    readonly detectedAt: Date;
    readonly actorUserId?: string;
    readonly notificationTestId?: string;
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
  markReadByOwner(input: {
    readonly teamId: string;
    readonly alertId: string;
    readonly userId: string;
    readonly now: Date;
  }): Promise<AlertRecord>;
  markReadByNotificationMember(input: {
    readonly teamId: string;
    readonly alertId: string;
    readonly memberId: string;
    readonly now: Date;
  }): Promise<AlertRecord>;
  dismissOwnerNotifications(input: {
    readonly teamId: string;
    readonly userId: string;
    readonly items: readonly NotificationCenterDeletionItem[];
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<NotificationCenterDeletionResult>;
  dismissNotificationMemberAlerts(input: {
    readonly teamId: string;
    readonly memberId: string;
    readonly alertIds: readonly string[];
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<NotificationCenterDeletionResult>;
  resolveByOwner(input: {
    readonly teamId: string;
    readonly alertId: string;
    readonly userId: string;
    readonly now: Date;
  }): Promise<AlertResolutionResult>;
}
