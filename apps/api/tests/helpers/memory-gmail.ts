import { randomUUID } from "node:crypto";
import { AppError } from "../../src/lib/app-error.js";
import type {
  GmailConnectionRecord,
  GmailConnectionRepository,
  GmailOAuthChallengeRecord,
  GmailOAuthIntent
} from "../../src/modules/gmail/gmail-connection-repository.js";
import type { StoredEncryptedToken } from "../../src/modules/gmail/token-encryption.js";

interface StoredChallenge extends GmailOAuthChallengeRecord {
  secretHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface StoredAuthorization {
  id: string;
  userId: string;
  subject: string;
  email: string;
  token: StoredEncryptedToken | null;
  scopes: readonly string[];
  status: GmailConnectionRecord["authorizationStatus"];
  lastVerifiedAt: Date | null;
}

export class MemoryGmailConnectionRepository implements GmailConnectionRepository {
  public readonly challenges: StoredChallenge[] = [];
  public readonly authorizations = new Map<string, StoredAuthorization>();
  public readonly connections = new Map<string, GmailConnectionRecord>();
  public readonly auditActions: string[] = [];

  public async createOAuthChallenge(input: {
    readonly userId: string;
    readonly teamId: string;
    readonly secretHash: string;
    readonly codeVerifier: string;
    readonly nonce: string;
    readonly intent: GmailOAuthIntent;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<void> {
    for (const challenge of this.challenges) {
      if (challenge.userId === input.userId && !challenge.consumedAt) {
        challenge.consumedAt = input.now;
      }
    }
    this.challenges.push({
      userId: input.userId,
      teamId: input.teamId,
      secretHash: input.secretHash,
      codeVerifier: input.codeVerifier,
      nonce: input.nonce,
      intent: input.intent,
      expiresAt: input.expiresAt,
      consumedAt: null
    });
  }

  public async consumeOAuthChallenge(
    secretHash: string,
    expectedUserId: string,
    now: Date
  ): Promise<GmailOAuthChallengeRecord | null> {
    const challenge = this.challenges.find(
      (candidate) => candidate.secretHash === secretHash
    );
    if (
      !challenge ||
      challenge.userId !== expectedUserId ||
      challenge.consumedAt ||
      challenge.expiresAt <= now
    ) {
      return null;
    }
    challenge.consumedAt = now;
    return challenge;
  }

  public async findConnection(
    teamId: string,
    ownerUserId: string
  ): Promise<GmailConnectionRecord | null> {
    const authorization = this.authorizations.get(ownerUserId);
    const connection = this.connections.get(teamId);
    return authorization && connection?.authorizationId === authorization.id
      ? connection
      : null;
  }

  public async saveGrant(input: {
    readonly teamId: string;
    readonly ownerUserId: string;
    readonly providerSubject: string;
    readonly email: string;
    readonly encryptedToken: StoredEncryptedToken;
    readonly grantedScopes: readonly string[];
    readonly intent: GmailOAuthIntent;
    readonly requestId: string | null;
    readonly now: Date;
  }) {
    const duplicate = [...this.authorizations.values()].find(
      (authorization) =>
        authorization.userId !== input.ownerUserId &&
        authorization.subject === input.providerSubject
    );
    if (duplicate) {
      throw new AppError("GMAIL_ACCOUNT_ALREADY_IN_USE", "duplicate", 409);
    }
    const existing = this.authorizations.get(input.ownerUserId);
    const obsoleteTokens = existing?.token ? [existing.token] : [];
    const authorization: StoredAuthorization = {
      id: existing?.id ?? randomUUID(),
      userId: input.ownerUserId,
      subject: input.providerSubject,
      email: input.email,
      token: input.encryptedToken,
      scopes: input.grantedScopes,
      status: "ACTIVE",
      lastVerifiedAt: input.now
    };
    this.authorizations.set(input.ownerUserId, authorization);
    for (const [teamId, candidate] of this.connections) {
      if (
        teamId !== input.teamId &&
        candidate.authorizationId === authorization.id &&
        candidate.connectionStatus !== "REVOKED"
      ) {
        this.connections.set(teamId, {
          ...candidate,
          email: input.email,
          authorizationStatus: "ACTIVE",
          connectionStatus:
            candidate.connectionStatus === "REAUTH_REQUIRED"
              ? "ACTIVE"
              : candidate.connectionStatus,
          grantedScopes: input.grantedScopes,
          lastVerifiedAt: input.now,
          lastErrorCode:
            candidate.connectionStatus === "REAUTH_REQUIRED"
              ? null
              : candidate.lastErrorCode
        });
      }
    }
    const previousConnection = this.connections.get(input.teamId);
    const connection: GmailConnectionRecord = {
      id: previousConnection?.id ?? randomUUID(),
      teamId: input.teamId,
      authorizationId: authorization.id,
      email: input.email,
      authorizationStatus: "ACTIVE",
      connectionStatus: "ACTIVE",
      grantedScopes: input.grantedScopes,
      lastVerifiedAt: input.now,
      lastSyncAt: null,
      lastErrorCode: null
    };
    this.connections.set(input.teamId, connection);
    this.auditActions.push(
      existing || previousConnection || input.intent === "REAUTHORIZE"
        ? "GMAIL_REAUTHORIZED"
        : "GMAIL_CONNECTED"
    );
    return { connection, obsoleteTokens };
  }

  public async disconnect(input: {
    readonly teamId: string;
    readonly ownerUserId: string;
    readonly requestId: string | null;
    readonly now: Date;
  }) {
    const connection = this.connections.get(input.teamId);
    const authorization = this.authorizations.get(input.ownerUserId);
    if (!connection || !authorization) {
      throw new AppError("GMAIL_CONNECTION_NOT_FOUND", "missing", 404);
    }
    this.connections.set(input.teamId, {
      ...connection,
      connectionStatus: "REVOKED"
    });
    const activeConnections = [...this.connections.values()].filter(
      (candidate) =>
        candidate.authorizationId === authorization.id &&
        candidate.connectionStatus !== "REVOKED"
    );
    const tokenToRevoke =
      activeConnections.length === 0 ? authorization.token : null;
    if (activeConnections.length === 0) {
      this.authorizations.set(input.ownerUserId, {
        ...authorization,
        token: null,
        status: "REVOKED"
      });
    }
    this.auditActions.push("GMAIL_CONNECTION_DISCONNECTED");
    return { tokenToRevoke };
  }

  public async markAuthorizationRequiresReauth(input: {
    readonly authorizationId: string;
    readonly errorCode: string;
    readonly now: Date;
  }): Promise<void> {
    for (const [userId, authorization] of this.authorizations) {
      if (authorization.id === input.authorizationId) {
        this.authorizations.set(userId, {
          ...authorization,
          status: "REAUTH_REQUIRED"
        });
      }
    }
    for (const [teamId, connection] of this.connections) {
      if (connection.authorizationId === input.authorizationId) {
        this.connections.set(teamId, {
          ...connection,
          authorizationStatus: "REAUTH_REQUIRED",
          connectionStatus: "REAUTH_REQUIRED",
          lastErrorCode: input.errorCode
        });
      }
    }
    this.auditActions.push("GMAIL_CREDENTIAL_REAUTH_REQUIRED");
  }
}
