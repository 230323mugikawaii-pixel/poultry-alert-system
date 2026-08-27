import type { StoredEncryptedToken } from "./token-encryption.js";

export type GmailOAuthIntent = "CONNECT" | "REAUTHORIZE";
export type GmailAuthorizationState =
  "ACTIVE" | "REAUTH_REQUIRED" | "REVOKED" | "ERROR";
export type GmailConnectionState = GmailAuthorizationState;

export interface GmailOAuthChallengeRecord {
  readonly userId: string;
  readonly teamId: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly intent: GmailOAuthIntent;
}

export interface GmailConnectionRecord {
  readonly id: string;
  readonly teamId: string;
  readonly authorizationId: string;
  readonly email: string;
  readonly authorizationStatus: GmailAuthorizationState;
  readonly connectionStatus: GmailConnectionState;
  readonly grantedScopes: readonly string[];
  readonly lastVerifiedAt: Date | null;
  readonly lastSyncAt: Date | null;
  readonly lastErrorCode: string | null;
}

export interface GmailGrantPersistenceResult {
  readonly connection: GmailConnectionRecord;
  readonly obsoleteTokens: readonly StoredEncryptedToken[];
}

export interface GmailDisconnectResult {
  readonly tokenToRevoke: StoredEncryptedToken | null;
}

export interface GmailConnectionRepository {
  createOAuthChallenge(input: {
    readonly userId: string;
    readonly teamId: string;
    readonly secretHash: string;
    readonly codeVerifier: string;
    readonly nonce: string;
    readonly intent: GmailOAuthIntent;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<void>;
  consumeOAuthChallenge(
    secretHash: string,
    expectedUserId: string,
    now: Date
  ): Promise<GmailOAuthChallengeRecord | null>;
  findConnection(
    teamId: string,
    ownerUserId: string
  ): Promise<GmailConnectionRecord | null>;
  saveGrant(input: {
    readonly teamId: string;
    readonly ownerUserId: string;
    readonly providerSubject: string;
    readonly email: string;
    readonly encryptedToken: StoredEncryptedToken;
    readonly grantedScopes: readonly string[];
    readonly intent: GmailOAuthIntent;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<GmailGrantPersistenceResult>;
  disconnect(input: {
    readonly teamId: string;
    readonly ownerUserId: string;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<GmailDisconnectResult>;
  markAuthorizationRequiresReauth(input: {
    readonly authorizationId: string;
    readonly errorCode: string;
    readonly now: Date;
  }): Promise<void>;
}
