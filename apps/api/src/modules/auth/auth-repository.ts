export interface AuthUserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: "ACTIVE" | "LOCKED" | "DELETED";
}

export interface AuthSessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly deviceId: string | null;
  readonly deviceName: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly current?: boolean;
}

export interface CreateMagicLinkChallengeInput {
  readonly email: string;
  readonly secretHash: string;
  readonly expiresAt: Date;
}

export interface CreateSessionInput {
  readonly userId: string;
  readonly tokenHash: string;
  readonly deviceName: string | null;
  readonly ipHash: string | null;
  readonly userAgentHash: string | null;
  readonly idleExpiresAt: Date;
  readonly expiresAt: Date;
  readonly maxActiveSessions: number;
}

export interface AuthRepository {
  createMagicLinkChallenge(input: CreateMagicLinkChallengeInput): Promise<void>;
  consumeMagicLink(
    secretHash: string,
    now: Date
  ): Promise<AuthUserRecord | null>;
  createSession(input: CreateSessionInput): Promise<AuthSessionRecord>;
  findActiveSession(
    tokenHash: string,
    now: Date
  ): Promise<{
    readonly user: AuthUserRecord;
    readonly session: AuthSessionRecord;
  } | null>;
  touchSession(
    sessionId: string,
    now: Date,
    idleExpiresAt: Date
  ): Promise<void>;
  listSessions(userId: string): Promise<readonly AuthSessionRecord[]>;
  revokeSession(userId: string, sessionId: string, now: Date): Promise<boolean>;
  revokeAllSessions(userId: string, now: Date): Promise<void>;
}
