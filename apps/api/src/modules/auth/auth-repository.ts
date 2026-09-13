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

export interface CreateGoogleOAuthChallengeInput {
  readonly secretHash: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly expiresAt: Date;
}

export interface ResolveGoogleUserInput {
  readonly providerSubject: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly emailVerified: boolean;
  readonly now: Date;
}

export type PrimaryIdentityProvider = "GOOGLE" | "MICROSOFT" | "APPLE";
export type PrimaryOAuthIntent = "LOGIN" | "LINK";

export interface CreatePrimaryOAuthChallengeInput {
  readonly provider: PrimaryIdentityProvider;
  readonly intent: PrimaryOAuthIntent;
  readonly userId: string | null;
  readonly secretHash: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly expiresAt: Date;
}

export interface PrimaryOAuthChallengeRecord {
  readonly provider: PrimaryIdentityProvider;
  readonly intent: PrimaryOAuthIntent;
  readonly userId: string | null;
  readonly codeVerifier: string;
  readonly nonce: string;
}

export interface ResolvePrimaryIdentityInput {
  readonly provider: PrimaryIdentityProvider;
  readonly providerSubject: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly emailVerified: boolean;
  readonly now: Date;
}

export interface PrimaryIdentityRecord {
  readonly provider: PrimaryIdentityProvider;
  readonly email: string;
  readonly linkedAt: Date;
  readonly lastUsedAt: Date | null;
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
  createGoogleOAuthChallenge(
    input: CreateGoogleOAuthChallengeInput
  ): Promise<void>;
  consumeGoogleOAuthChallenge(
    secretHash: string,
    now: Date
  ): Promise<{
    readonly codeVerifier: string;
    readonly nonce: string;
  } | null>;
  resolveGoogleUser(input: ResolveGoogleUserInput): Promise<AuthUserRecord>;
  createPrimaryOAuthChallenge(
    input: CreatePrimaryOAuthChallengeInput
  ): Promise<void>;
  consumePrimaryOAuthChallenge(
    secretHash: string,
    provider: PrimaryIdentityProvider,
    authenticatedUserId: string | null,
    now: Date
  ): Promise<PrimaryOAuthChallengeRecord | null>;
  resolvePrimaryIdentityUser(
    input: ResolvePrimaryIdentityInput
  ): Promise<AuthUserRecord>;
  linkPrimaryIdentity(
    userId: string,
    input: ResolvePrimaryIdentityInput
  ): Promise<PrimaryIdentityRecord>;
  listPrimaryIdentities(
    userId: string
  ): Promise<readonly PrimaryIdentityRecord[]>;
  unlinkPrimaryIdentity(
    userId: string,
    provider: PrimaryIdentityProvider,
    now: Date
  ): Promise<void>;
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
