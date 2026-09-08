import { createHash, createHmac, randomBytes } from "node:crypto";
import { AppError } from "../../lib/app-error.js";
import type {
  MailAuthorizationState,
  MailConnectionRecord,
  MailConnectionRepository,
  MailOAuthIntent,
  ProviderToken
} from "./mail-connection-repository.js";
import {
  readMailOAuthFailureReason,
  type MailOAuthFailureReason,
  type MailProviderAdapter,
  type MailProviderErrorKind,
  type MailProviderId
} from "./mail-provider.js";
import type { TokenEncryptionProvider } from "./token-encryption.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class MailConnectionService {
  private readonly now: () => Date;
  private readonly providers: ReadonlyMap<MailProviderId, MailProviderAdapter>;

  public constructor(
    private readonly options: {
      readonly repository: MailConnectionRepository;
      readonly providerAdapters: readonly MailProviderAdapter[];
      readonly tokenEncryption: TokenEncryptionProvider;
      readonly tokenPepper: string;
      readonly stateTtlMinutes: Readonly<Record<MailProviderId, number>>;
      readonly monitoringTopics?: Readonly<
        Partial<Record<MailProviderId, string>>
      >;
      readonly now?: () => Date;
    }
  ) {
    this.now = options.now ?? (() => new Date());
    this.providers = new Map(
      options.providerAdapters.map((adapter) => [adapter.provider, adapter])
    );
    if (!this.providers.has("GOOGLE") || !this.providers.has("MICROSOFT")) {
      throw new Error("mail_provider_adapters_incomplete");
    }
  }

  public async createAuthorizationRequest(
    userId: string,
    teamId: string,
    intent: MailOAuthIntent,
    provider: MailProviderId,
    connectionId: string | null = null
  ): Promise<{
    readonly state: string;
    readonly authorizationUrl: string;
    readonly expiresAt: Date;
  }> {
    const adapter = this.requireProvider(provider);
    if (intent === "REAUTHORIZE") {
      if (!connectionId) {
        throw new AppError(
          "MAIL_CONNECTION_REQUIRED",
          "再認証するメール監視アカウントを選択してください。",
          400
        );
      }
      const connection = await this.options.repository.findConnectionById(
        teamId,
        userId,
        connectionId
      );
      if (!connection) {
        throw new AppError(
          "MAIL_CONNECTION_NOT_FOUND",
          "メール監視アカウントが見つかりません。",
          404
        );
      }
      if (connection.provider !== provider) {
        throw new AppError(
          "MAIL_PROVIDER_MISMATCH",
          "選択したメール監視アカウントと認証先が一致しません。",
          409
        );
      }
    }
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier, "utf8")
      .digest("base64url");
    const now = this.now();
    const expiresAt = new Date(
      now.getTime() + this.options.stateTtlMinutes[provider] * 60_000
    );
    await this.options.repository.createOAuthChallenge({
      userId,
      teamId,
      secretHash: this.hashSecret(state),
      codeVerifier,
      nonce,
      intent,
      provider,
      connectionId,
      expiresAt,
      now
    });
    return {
      state,
      authorizationUrl: adapter.createAuthorizationUrl({
        state,
        codeChallenge,
        nonce
      }),
      expiresAt
    };
  }

  public async completeAuthorization(input: {
    readonly provider: MailProviderId;
    readonly state: string;
    readonly code: string;
    readonly authenticatedUserId: string;
    readonly requestId?: string;
  }): Promise<MailConnectionRecord> {
    if (!isPlausibleState(input.state) || !isPlausibleCode(input.code)) {
      throw invalidMailAuthorizationError();
    }
    const challenge = await this.options.repository.consumeOAuthChallenge(
      this.hashSecret(input.state),
      input.authenticatedUserId,
      this.now()
    );
    if (!challenge || challenge.provider !== input.provider) {
      throw invalidMailAuthorizationError();
    }

    const adapter = this.requireProvider(challenge.provider);
    let grant;
    try {
      grant = await adapter.exchangeCode({
        code: input.code,
        codeVerifier: challenge.codeVerifier,
        expectedNonce: challenge.nonce
      });
    } catch (error) {
      throw invalidMailAuthorizationError(readMailOAuthFailureReason(error));
    }
    const email = grant.email.trim().toLowerCase();
    if (
      grant.provider !== challenge.provider ||
      !grant.emailVerified ||
      !EMAIL_PATTERN.test(email) ||
      email.length > 320 ||
      !grant.subject ||
      grant.subject.length > 255
    ) {
      throw invalidMailAuthorizationError();
    }

    const encryptedToken = await this.options.tokenEncryption.encrypt(
      grant.refreshToken
    );
    const persisted = await this.options.repository.saveGrant({
      teamId: challenge.teamId,
      ownerUserId: challenge.userId,
      provider: challenge.provider,
      providerSubject: grant.subject,
      email,
      encryptedToken,
      grantedScopes: [...new Set(grant.grantedScopes)].sort(),
      intent: challenge.intent,
      connectionId: challenge.connectionId,
      deferActivation: Boolean(
        this.options.monitoringTopics?.[challenge.provider]
      ),
      requestId: input.requestId ?? null,
      now: this.now()
    });
    await Promise.all(
      persisted.obsoleteTokens.map((token) =>
        this.revokeObsoleteToken(token, challenge.provider, grant.refreshToken)
      )
    );
    if (
      persisted.connection.provider === "GOOGLE" &&
      persisted.connection.connectionStatus === "PAUSED"
    ) {
      return this.setMonitoringState({
        teamId: persisted.connection.teamId,
        ownerUserId: challenge.userId,
        connectionId: persisted.connection.id,
        status: "ACTIVE",
        ...(input.requestId ? { requestId: input.requestId } : {})
      });
    }
    return persisted.connection;
  }

  public getConnections(
    teamId: string,
    ownerUserId: string
  ): Promise<readonly MailConnectionRecord[]> {
    return this.options.repository.listConnections(teamId, ownerUserId);
  }

  public async disconnect(input: {
    readonly teamId: string;
    readonly ownerUserId: string;
    readonly connectionId?: string;
    readonly requestId?: string;
  }): Promise<void> {
    const result = await this.options.repository.disconnect({
      teamId: input.teamId,
      ownerUserId: input.ownerUserId,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      requestId: input.requestId ?? null,
      now: this.now()
    });
    await this.stopObsoleteWatch(result.tokenToRevoke);
    await this.revokeObsoleteToken(result.tokenToRevoke);
  }

  public async setMonitoringState(input: {
    readonly teamId: string;
    readonly ownerUserId: string;
    readonly connectionId: string;
    readonly status: "ACTIVE" | "PAUSED";
    readonly requestId?: string;
  }): Promise<MailConnectionRecord> {
    const now = this.now();
    if (input.status === "PAUSED") {
      const result = await this.options.repository.setMonitoringState({
        teamId: input.teamId,
        ownerUserId: input.ownerUserId,
        connectionId: input.connectionId,
        status: input.status,
        watch: null,
        requestId: input.requestId ?? null,
        now
      });
      await this.stopMailboxWatches(result.tokensToStop);
      return result.connection;
    }

    const target = await this.options.repository.getMonitoringActivationTarget({
      teamId: input.teamId,
      ownerUserId: input.ownerUserId,
      connectionId: input.connectionId
    });
    if (target.connection.connectionStatus === "ACTIVE") {
      return target.connection;
    }

    const topicName =
      this.options.monitoringTopics?.[target.connection.provider];
    let watch: {
      readonly providerCursor: string;
      readonly expiration: Date;
      readonly renewedAt: Date;
    } | null = null;
    let plaintextToken: string | null = null;
    if (topicName) {
      const provider = this.requireProvider(target.connection.provider);
      if (!provider.startMailboxWatch) {
        throw new AppError(
          "MAIL_MONITORING_START_UNAVAILABLE",
          "メール監視を開始できませんでした。しばらくしてからもう一度お試しください。",
          503
        );
      }
      plaintextToken = await this.options.tokenEncryption.decrypt(
        target.credential.token
      );
      try {
        const started = await provider.startMailboxWatch(
          plaintextToken,
          topicName
        );
        watch = {
          providerCursor: started.providerCursor,
          expiration: started.expiration,
          renewedAt: now
        };
      } catch (error) {
        await this.handleMonitoringStartFailure(target.connection, error);
      }
    }

    try {
      const result = await this.options.repository.setMonitoringState({
        teamId: input.teamId,
        ownerUserId: input.ownerUserId,
        connectionId: input.connectionId,
        status: input.status,
        watch,
        requestId: input.requestId ?? null,
        now
      });
      await this.stopMailboxWatches(result.tokensToStop);
      return result.connection;
    } catch (error) {
      if (watch && plaintextToken) {
        const current = await this.options.repository.findConnectionById(
          input.teamId,
          input.ownerUserId,
          input.connectionId
        );
        if (current?.connectionStatus !== "ACTIVE") {
          await this.stopPlaintextWatch(
            target.connection.provider,
            plaintextToken
          );
        }
      }
      throw error;
    }
  }

  public async markProviderFailure(input: {
    readonly authorizationId: string;
    readonly provider: MailProviderId;
    readonly error: unknown;
  }): Promise<MailProviderErrorKind> {
    const classification = this.requireProvider(
      input.provider
    ).classifyProviderError(input.error);
    const status: MailAuthorizationState = [
      "REAUTHORIZATION_REQUIRED",
      "CONSENT_REQUIRED",
      "FORBIDDEN"
    ].includes(classification)
      ? "REAUTH_REQUIRED"
      : "ERROR";
    await this.options.repository.markAuthorizationFailure({
      authorizationId: input.authorizationId,
      status,
      errorCode: classification,
      now: this.now()
    });
    return classification;
  }

  private requireProvider(provider: MailProviderId): MailProviderAdapter {
    const adapter = this.providers.get(provider);
    if (!adapter) {
      throw new AppError(
        "MAIL_PROVIDER_NOT_SUPPORTED",
        "このメールサービスには対応していません。",
        400
      );
    }
    return adapter;
  }

  private async revokeObsoleteToken(
    providerToken: ProviderToken | null,
    activeProvider?: MailProviderId,
    activeRefreshToken?: string
  ): Promise<void> {
    if (!providerToken) return;
    try {
      const plaintext = await this.options.tokenEncryption.decrypt(
        providerToken.token
      );
      if (
        providerToken.provider === activeProvider &&
        plaintext === activeRefreshToken
      ) {
        return;
      }
      await this.requireProvider(providerToken.provider).revokeAuthorization(
        plaintext
      );
    } catch {
      // The credential is already disabled in Call Now. Provider revocation is
      // deliberately best-effort and never re-enables local monitoring.
    }
  }

  private async stopObsoleteWatch(
    providerToken: ProviderToken | null
  ): Promise<void> {
    if (!providerToken) return;
    const provider = this.requireProvider(providerToken.provider);
    if (!provider.stopMailboxWatch) return;
    try {
      const plaintext = await this.options.tokenEncryption.decrypt(
        providerToken.token
      );
      await provider.stopMailboxWatch(plaintext);
    } catch {
      // Local revocation is authoritative. Provider watch shutdown is
      // deliberately best-effort and must not restore a disconnected account.
    }
  }

  private async stopMailboxWatches(
    providerTokens: readonly ProviderToken[]
  ): Promise<void> {
    await Promise.all(
      providerTokens.map(async (providerToken) => {
        if (!this.options.monitoringTopics?.[providerToken.provider]) return;
        try {
          const plaintext = await this.options.tokenEncryption.decrypt(
            providerToken.token
          );
          await this.stopPlaintextWatch(providerToken.provider, plaintext);
        } catch {
          // The database state is authoritative. A provider-side stop is
          // best-effort and a stale push cannot reactivate a paused connection.
        }
      })
    );
  }

  private async stopPlaintextWatch(
    providerId: MailProviderId,
    plaintextToken: string
  ): Promise<void> {
    const provider = this.requireProvider(providerId);
    if (!provider.stopMailboxWatch) return;
    try {
      await provider.stopMailboxWatch(plaintextToken);
    } catch {
      // Local state remains authoritative when the provider cannot stop a
      // mailbox watch immediately.
    }
  }

  private async handleMonitoringStartFailure(
    connection: MailConnectionRecord,
    error: unknown
  ): Promise<never> {
    const classification = this.requireProvider(
      connection.provider
    ).classifyProviderError(error);
    if (
      classification === "REAUTHORIZATION_REQUIRED" ||
      classification === "CONSENT_REQUIRED" ||
      classification === "FORBIDDEN"
    ) {
      await this.options.repository.markAuthorizationFailure({
        authorizationId: connection.authorizationId,
        status: "REAUTH_REQUIRED",
        errorCode: classification,
        now: this.now()
      });
      throw new AppError(
        "MAIL_REAUTHORIZATION_REQUIRED",
        "監視を開始するにはメールアカウントの再設定が必要です。",
        409
      );
    }
    throw new AppError(
      "MAIL_MONITORING_START_FAILED",
      "メール監視を開始できませんでした。現在監視中のアカウントは変更されていません。",
      503
    );
  }

  private hashSecret(value: string): string {
    return createHmac("sha256", this.options.tokenPepper)
      .update(value, "utf8")
      .digest("hex");
  }
}

function isPlausibleState(value: string): boolean {
  return /^[A-Za-z0-9_-]{40,100}$/.test(value);
}

function isPlausibleCode(value: string): boolean {
  return value.length >= 10 && value.length <= 4096 && !/[\r\n\0]/u.test(value);
}

function invalidMailAuthorizationError(
  reasonCode?: MailOAuthFailureReason
): AppError {
  return new AppError(
    "MAIL_AUTHORIZATION_INVALID_OR_EXPIRED",
    "メール連携が無効または期限切れです。もう一度お試しください。",
    401,
    reasonCode ? { reasonCode } : undefined
  );
}
