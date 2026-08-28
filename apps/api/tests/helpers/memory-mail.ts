import { randomUUID } from "node:crypto";
import { AppError } from "../../src/lib/app-error.js";
import type {
  MailConnectionRecord,
  MailConnectionRepository,
  MailOAuthChallengeRecord,
  MailOAuthIntent,
  ProviderToken
} from "../../src/modules/mail/mail-connection-repository.js";
import type { MailProviderId } from "../../src/modules/mail/mail-provider.js";
import type { StoredEncryptedToken } from "../../src/modules/mail/token-encryption.js";

interface StoredChallenge extends MailOAuthChallengeRecord {
  secretHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface StoredAuthorization {
  id: string;
  userId: string;
  provider: MailProviderId;
  subject: string;
  email: string;
  token: StoredEncryptedToken | null;
  scopes: readonly string[];
  status: MailConnectionRecord["authorizationStatus"];
  lastVerifiedAt: Date | null;
}

export class MemoryMailConnectionRepository implements MailConnectionRepository {
  public readonly challenges: StoredChallenge[] = [];
  public readonly authorizations = new Map<string, StoredAuthorization>();
  public readonly connections = new Map<string, MailConnectionRecord>();
  public readonly auditActions: string[] = [];

  public async createOAuthChallenge(input: {
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
  }): Promise<void> {
    for (const challenge of this.challenges) {
      if (
        challenge.userId === input.userId &&
        challenge.provider === input.provider &&
        !challenge.consumedAt
      ) {
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
      provider: input.provider,
      connectionId: input.connectionId,
      expiresAt: input.expiresAt,
      consumedAt: null
    });
  }

  public async consumeOAuthChallenge(
    secretHash: string,
    expectedUserId: string,
    now: Date
  ): Promise<MailOAuthChallengeRecord | null> {
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

  public async listConnections(
    teamId: string,
    ownerUserId: string
  ): Promise<readonly MailConnectionRecord[]> {
    void ownerUserId;
    return [...this.connections.values()].filter(
      (connection) =>
        connection.teamId === teamId &&
        connection.connectionStatus !== "REVOKED"
    );
  }

  public async findConnectionById(
    teamId: string,
    ownerUserId: string,
    connectionId: string
  ): Promise<MailConnectionRecord | null> {
    void ownerUserId;
    const connection = this.connections.get(connectionId);
    return connection?.teamId === teamId &&
      connection.connectionStatus !== "REVOKED"
      ? connection
      : null;
  }

  public async saveGrant(input: {
    readonly teamId: string;
    readonly ownerUserId: string;
    readonly provider: MailProviderId;
    readonly providerSubject: string;
    readonly email: string;
    readonly encryptedToken: StoredEncryptedToken;
    readonly grantedScopes: readonly string[];
    readonly intent: MailOAuthIntent;
    readonly connectionId: string | null;
    readonly requestId: string | null;
    readonly now: Date;
  }) {
    const duplicate = [...this.authorizations.values()].find(
      (authorization) =>
        authorization.userId !== input.ownerUserId &&
        authorization.provider === input.provider &&
        authorization.subject === input.providerSubject
    );
    if (duplicate) {
      throw new AppError("MAIL_ACCOUNT_ALREADY_IN_USE", "duplicate", 409);
    }
    const targetConnection = input.connectionId
      ? this.connections.get(input.connectionId)
      : undefined;
    if (
      input.intent === "REAUTHORIZE" &&
      (!targetConnection || targetConnection.teamId !== input.teamId)
    ) {
      throw new AppError("MAIL_CONNECTION_NOT_FOUND", "missing", 404);
    }
    const subjectAuthorization = [...this.authorizations.values()].find(
      (authorization) =>
        authorization.userId === input.ownerUserId &&
        authorization.provider === input.provider &&
        authorization.subject === input.providerSubject
    );
    const targetAuthorization = targetConnection
      ? this.authorizations.get(targetConnection.authorizationId)
      : undefined;
    if (
      targetAuthorization &&
      (targetAuthorization.provider !== input.provider ||
        targetAuthorization.subject !== input.providerSubject)
    ) {
      throw new AppError("MAIL_REAUTH_ACCOUNT_MISMATCH", "mismatch", 409);
    }
    const existing = targetAuthorization ?? subjectAuthorization;
    const obsoleteTokens: ProviderToken[] = existing?.token
      ? [{ provider: existing.provider, token: existing.token }]
      : [];
    const authorization: StoredAuthorization = {
      id: existing?.id ?? randomUUID(),
      userId: input.ownerUserId,
      provider: input.provider,
      subject: input.providerSubject,
      email: input.email,
      token: input.encryptedToken,
      scopes: input.grantedScopes,
      status: "ACTIVE",
      lastVerifiedAt: input.now
    };
    this.authorizations.set(authorization.id, authorization);
    for (const [connectionId, candidate] of this.connections) {
      if (
        candidate.teamId !== input.teamId &&
        candidate.authorizationId === authorization.id &&
        candidate.connectionStatus !== "REVOKED"
      ) {
        this.connections.set(connectionId, {
          ...candidate,
          provider: input.provider,
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
    const previousConnection = [...this.connections.values()].find(
      (candidate) =>
        candidate.teamId === input.teamId &&
        candidate.authorizationId === authorization.id
    );
    const connection: MailConnectionRecord = {
      id: previousConnection?.id ?? randomUUID(),
      teamId: input.teamId,
      authorizationId: authorization.id,
      provider: input.provider,
      email: input.email,
      authorizationStatus: "ACTIVE",
      connectionStatus: "ACTIVE",
      grantedScopes: input.grantedScopes,
      lastVerifiedAt: input.now,
      lastSyncAt: null,
      lastErrorCode: null
    };
    this.connections.set(connection.id, connection);
    this.auditActions.push(
      existing || previousConnection || input.intent === "REAUTHORIZE"
        ? "MAIL_REAUTHORIZED"
        : "MAIL_CONNECTED"
    );
    return { connection, obsoleteTokens };
  }

  public async disconnect(input: {
    readonly teamId: string;
    readonly ownerUserId: string;
    readonly connectionId?: string;
    readonly requestId: string | null;
    readonly now: Date;
  }) {
    const connection = input.connectionId
      ? this.connections.get(input.connectionId)
      : [...this.connections.values()].find(
          (candidate) =>
            candidate.teamId === input.teamId &&
            candidate.connectionStatus !== "REVOKED"
        );
    const authorization = connection
      ? this.authorizations.get(connection.authorizationId)
      : undefined;
    if (!connection || !authorization) {
      throw new AppError("MAIL_CONNECTION_NOT_FOUND", "missing", 404);
    }
    this.connections.set(connection.id, {
      ...connection,
      connectionStatus: "REVOKED"
    });
    const activeConnections = [...this.connections.values()].filter(
      (candidate) =>
        candidate.authorizationId === authorization.id &&
        candidate.connectionStatus !== "REVOKED"
    );
    const tokenToRevoke =
      activeConnections.length === 0 && authorization.token
        ? { provider: authorization.provider, token: authorization.token }
        : null;
    if (activeConnections.length === 0) {
      this.authorizations.set(authorization.id, {
        ...authorization,
        token: null,
        status: "REVOKED"
      });
      this.auditActions.push("MAIL_AUTHORIZATION_REVOKED");
    }
    this.auditActions.push("MAIL_CONNECTION_DISCONNECTED");
    return { tokenToRevoke };
  }

  public async setMonitoringState(input: {
    readonly teamId: string;
    readonly ownerUserId: string;
    readonly connectionId: string;
    readonly status: "ACTIVE" | "PAUSED";
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<MailConnectionRecord> {
    void input.ownerUserId;
    void input.requestId;
    void input.now;
    const connection = this.connections.get(input.connectionId);
    if (!connection || connection.teamId !== input.teamId) {
      throw new AppError("MAIL_CONNECTION_NOT_FOUND", "missing", 404);
    }
    if (
      !["ACTIVE", "PAUSED"].includes(connection.connectionStatus) ||
      (input.status === "ACTIVE" && connection.authorizationStatus !== "ACTIVE")
    ) {
      throw new AppError("MAIL_CONNECTION_STATE_INVALID", "invalid", 409);
    }
    const updated = { ...connection, connectionStatus: input.status };
    this.connections.set(connection.id, updated);
    this.auditActions.push(
      input.status === "ACTIVE"
        ? "MAIL_MONITORING_RESUMED"
        : "MAIL_MONITORING_PAUSED"
    );
    return updated;
  }

  public async markAuthorizationFailure(input: {
    readonly authorizationId: string;
    readonly status: "REAUTH_REQUIRED" | "ERROR";
    readonly errorCode: string;
    readonly now: Date;
  }): Promise<void> {
    for (const [authorizationId, authorization] of this.authorizations) {
      if (authorization.id === input.authorizationId) {
        this.authorizations.set(authorizationId, {
          ...authorization,
          status: input.status
        });
      }
    }
    for (const [connectionId, connection] of this.connections) {
      if (connection.authorizationId === input.authorizationId) {
        this.connections.set(connectionId, {
          ...connection,
          authorizationStatus: input.status,
          connectionStatus: input.status,
          lastErrorCode: input.errorCode
        });
      }
    }
    this.auditActions.push(
      input.status === "REAUTH_REQUIRED"
        ? "MAIL_AUTHORIZATION_REAUTH_REQUIRED"
        : "MAIL_AUTHORIZATION_ERROR"
    );
  }
}
