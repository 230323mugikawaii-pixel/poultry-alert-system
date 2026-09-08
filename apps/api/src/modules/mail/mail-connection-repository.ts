import type { StoredEncryptedToken } from "./token-encryption.js";
import type { MailProviderId } from "./mail-provider.js";

export type MailOAuthIntent = "CONNECT" | "REAUTHORIZE";
export type MailAuthorizationState =
  "ACTIVE" | "REAUTH_REQUIRED" | "REVOKED" | "ERROR";
export type MailConnectionState = MailAuthorizationState | "PAUSED";

export interface MailOAuthChallengeRecord {
  readonly userId: string;
  readonly teamId: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly intent: MailOAuthIntent;
  readonly provider: MailProviderId;
  readonly connectionId: string | null;
}

export interface MailConnectionRecord {
  readonly id: string;
  readonly teamId: string;
  readonly authorizationId: string;
  readonly provider: MailProviderId;
  readonly email: string;
  readonly authorizationStatus: MailAuthorizationState;
  readonly connectionStatus: MailConnectionState;
  readonly keywords: readonly string[];
  readonly grantedScopes: readonly string[];
  readonly lastVerifiedAt: Date | null;
  readonly lastSyncAt: Date | null;
  readonly lastErrorCode: string | null;
}

export interface MailGrantPersistenceResult {
  readonly connection: MailConnectionRecord;
  readonly obsoleteTokens: readonly ProviderToken[];
}

export interface MailDisconnectResult {
  readonly tokenToRevoke: ProviderToken | null;
}

export interface MailMonitoringActivationTarget {
  readonly connection: MailConnectionRecord;
  readonly credential: ProviderToken;
}

export interface MailMonitoringStateResult {
  readonly connection: MailConnectionRecord;
  readonly tokensToStop: readonly ProviderToken[];
}

export interface ProviderToken {
  readonly provider: MailProviderId;
  readonly token: StoredEncryptedToken;
}

export interface MailConnectionRepository {
  createOAuthChallenge(input: {
    readonly userId: string;
    readonly teamId: string;
    readonly secretHash: string;
    readonly codeVerifier: string;
    readonly nonce: string;
    readonly intent: MailOAuthIntent;
    readonly provider: MailProviderId;
    readonly connectionId: string | null;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<void>;
  consumeOAuthChallenge(
    secretHash: string,
    expectedUserId: string,
    now: Date
  ): Promise<MailOAuthChallengeRecord | null>;
  listConnections(
    teamId: string,
    ownerUserId: string
  ): Promise<readonly MailConnectionRecord[]>;
  findConnectionById(
    teamId: string,
    ownerUserId: string,
    connectionId: string
  ): Promise<MailConnectionRecord | null>;
  saveGrant(input: {
    readonly teamId: string;
    readonly ownerUserId: string;
    readonly provider: MailProviderId;
    readonly providerSubject: string;
    readonly email: string;
    readonly encryptedToken: StoredEncryptedToken;
    readonly grantedScopes: readonly string[];
    readonly intent: MailOAuthIntent;
    readonly connectionId: string | null;
    readonly deferActivation: boolean;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<MailGrantPersistenceResult>;
  disconnect(input: {
    readonly teamId: string;
    readonly ownerUserId: string;
    readonly connectionId?: string;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<MailDisconnectResult>;
  getMonitoringActivationTarget(input: {
    readonly teamId: string;
    readonly ownerUserId: string;
    readonly connectionId: string;
  }): Promise<MailMonitoringActivationTarget>;
  setMonitoringState(input: {
    readonly teamId: string;
    readonly ownerUserId: string;
    readonly connectionId: string;
    readonly status: "ACTIVE" | "PAUSED";
    readonly watch: {
      readonly providerCursor: string;
      readonly expiration: Date;
      readonly renewedAt: Date;
    } | null;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<MailMonitoringStateResult>;
  markAuthorizationFailure(input: {
    readonly authorizationId: string;
    readonly status: "REAUTH_REQUIRED" | "ERROR";
    readonly errorCode: string;
    readonly now: Date;
  }): Promise<void>;
}
