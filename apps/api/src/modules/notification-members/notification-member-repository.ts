export type NotificationMemberStatus = "ACTIVE" | "DISABLED";

export interface NotificationMemberRecord {
  readonly id: string;
  readonly teamId: string;
  readonly callNowId: string;
  readonly displayName: string | null;
  readonly passwordHash: string;
  readonly status: NotificationMemberStatus;
  readonly createdAt: Date;
  readonly disabledAt: Date | null;
}

export interface NotificationMemberSessionRecord {
  readonly id: string;
  readonly notificationMemberId: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly idleExpiresAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface NotificationMemberAuthentication {
  readonly member: NotificationMemberRecord;
  readonly session: NotificationMemberSessionRecord;
  readonly team: {
    readonly id: string;
    readonly publicCode: string;
    readonly name: string | null;
  };
}

export interface NotificationMemberSeatSummary {
  readonly seatCount: number;
  readonly additionalSeatLimit: number;
  readonly activeNotificationMemberCount: number;
  readonly occupiedAdditionalSeats: number;
  readonly availableSeats: number;
  readonly pendingSeatCount: number | null;
}

export interface NotificationMemberListResult {
  readonly members: readonly NotificationMemberRecord[];
  readonly seats: NotificationMemberSeatSummary;
}

export interface NotificationMemberRepository {
  list(teamId: string): Promise<NotificationMemberListResult>;
  create(input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly callNowId: string;
    readonly displayName: string | null;
    readonly passwordHash: string;
    readonly now: Date;
  }): Promise<NotificationMemberRecord>;
  replacePassword(input: {
    readonly teamId: string;
    readonly memberId: string;
    readonly actorUserId: string;
    readonly passwordHash: string;
    readonly now: Date;
  }): Promise<NotificationMemberRecord>;
  disable(input: {
    readonly teamId: string;
    readonly memberId: string;
    readonly actorUserId: string;
    readonly now: Date;
  }): Promise<NotificationMemberListResult>;
  findByCallNowId(callNowId: string): Promise<NotificationMemberRecord | null>;
  createSession(input: {
    readonly memberId: string;
    readonly tokenHash: string;
    readonly ipHash: string | null;
    readonly userAgentHash: string | null;
    readonly idleExpiresAt: Date;
    readonly expiresAt: Date;
    readonly maxActiveSessions: number;
    readonly now: Date;
  }): Promise<NotificationMemberSessionRecord>;
  findActiveSession(
    tokenHash: string,
    now: Date
  ): Promise<NotificationMemberAuthentication | null>;
  touchSession(
    sessionId: string,
    lastSeenAt: Date,
    idleExpiresAt: Date
  ): Promise<void>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
}
