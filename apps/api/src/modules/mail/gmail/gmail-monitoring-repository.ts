import type { StoredEncryptedToken } from "../token-encryption.js";

export interface GmailMonitoringConnection {
  readonly id: string;
  readonly teamId: string;
  readonly authorizationId: string;
  readonly email: string;
  readonly keywords: readonly string[];
  readonly providerCursor: string | null;
  readonly lastSyncAt: Date | null;
  readonly providerSubscriptionExpiresAt: Date | null;
  readonly refreshToken: StoredEncryptedToken;
}

export interface GmailCursorUpdate {
  readonly connectionId: string;
  readonly leaseToken: string;
  readonly cursor: string;
  readonly now: Date;
  readonly watch?: {
    readonly expiration: Date;
    readonly renewedAt: Date;
  };
  readonly recovered?: boolean;
}

export interface GmailMonitoringRepository {
  findEligibleByEmail(
    email: string
  ): Promise<readonly GmailMonitoringConnection[]>;
  findEligibleById(
    connectionId: string
  ): Promise<GmailMonitoringConnection | null>;
  listWatchCandidates(
    renewBefore: Date,
    limit: number
  ): Promise<readonly GmailMonitoringConnection[]>;
  acquireSyncLease(input: {
    readonly connectionId: string;
    readonly leaseToken: string;
    readonly now: Date;
    readonly expiresAt: Date;
  }): Promise<GmailMonitoringConnection | null>;
  releaseSyncLease(connectionId: string, leaseToken: string): Promise<void>;
  recordWatch(input: {
    readonly connectionId: string;
    readonly initialCursor: string;
    readonly expiration: Date;
    readonly renewedAt: Date;
  }): Promise<boolean>;
  advanceCursor(input: GmailCursorUpdate): Promise<boolean>;
  recordTransientFailure(input: {
    readonly connectionId: string;
    readonly leaseToken?: string;
    readonly errorCode: string;
    readonly now: Date;
    readonly watchFailure?: boolean;
  }): Promise<void>;
  markReauthorizationRequired(input: {
    readonly authorizationId: string;
    readonly errorCode: string;
    readonly now: Date;
  }): Promise<void>;
  updateRefreshToken(input: {
    readonly authorizationId: string;
    readonly refreshToken: StoredEncryptedToken;
    readonly now: Date;
  }): Promise<void>;
}
