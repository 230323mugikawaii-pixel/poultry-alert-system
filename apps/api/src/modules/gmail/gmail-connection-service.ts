import { createHash, createHmac, randomBytes } from "node:crypto";
import { AppError } from "../../lib/app-error.js";
import type {
  GmailConnectionRecord,
  GmailConnectionRepository,
  GmailOAuthIntent
} from "./gmail-connection-repository.js";
import type { GmailOAuthProvider } from "./gmail-oauth-client.js";
import type { TokenEncryptionProvider } from "./token-encryption.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class GmailConnectionService {
  private readonly now: () => Date;

  public constructor(
    private readonly options: {
      readonly repository: GmailConnectionRepository;
      readonly oauthProvider: GmailOAuthProvider;
      readonly tokenEncryption: TokenEncryptionProvider;
      readonly tokenPepper: string;
      readonly stateTtlMinutes: number;
      readonly now?: () => Date;
    }
  ) {
    this.now = options.now ?? (() => new Date());
  }

  public async createAuthorizationRequest(
    userId: string,
    teamId: string,
    intent: GmailOAuthIntent
  ): Promise<{
    readonly state: string;
    readonly authorizationUrl: string;
    readonly expiresAt: Date;
  }> {
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier, "utf8")
      .digest("base64url");
    const now = this.now();
    const expiresAt = new Date(
      now.getTime() + this.options.stateTtlMinutes * 60_000
    );
    await this.options.repository.createOAuthChallenge({
      userId,
      teamId,
      secretHash: this.hashSecret(state),
      codeVerifier,
      nonce,
      intent,
      expiresAt,
      now
    });
    return {
      state,
      authorizationUrl: this.options.oauthProvider.createAuthorizationUrl({
        state,
        codeChallenge,
        nonce
      }),
      expiresAt
    };
  }

  public async completeAuthorization(input: {
    readonly state: string;
    readonly code: string;
    readonly authenticatedUserId: string;
    readonly requestId?: string;
  }): Promise<GmailConnectionRecord> {
    if (!isPlausibleState(input.state) || !isPlausibleCode(input.code)) {
      throw invalidGmailAuthorizationError();
    }
    const challenge = await this.options.repository.consumeOAuthChallenge(
      this.hashSecret(input.state),
      input.authenticatedUserId,
      this.now()
    );
    if (!challenge) {
      throw invalidGmailAuthorizationError();
    }

    let grant;
    try {
      grant = await this.options.oauthProvider.exchangeCode({
        code: input.code,
        codeVerifier: challenge.codeVerifier,
        expectedNonce: challenge.nonce
      });
    } catch {
      throw invalidGmailAuthorizationError();
    }
    const email = grant.email.trim().toLowerCase();
    if (
      !grant.emailVerified ||
      !EMAIL_PATTERN.test(email) ||
      email.length > 320 ||
      !grant.subject ||
      grant.subject.length > 255
    ) {
      throw invalidGmailAuthorizationError();
    }

    const encryptedToken = await this.options.tokenEncryption.encrypt(
      grant.refreshToken
    );
    const persisted = await this.options.repository.saveGrant({
      teamId: challenge.teamId,
      ownerUserId: challenge.userId,
      providerSubject: grant.subject,
      email,
      encryptedToken,
      grantedScopes: [...new Set(grant.grantedScopes)].sort(),
      intent: challenge.intent,
      requestId: input.requestId ?? null,
      now: this.now()
    });
    await Promise.all(
      persisted.obsoleteTokens.map((token) =>
        this.revokeObsoleteToken(token, grant.refreshToken)
      )
    );
    return persisted.connection;
  }

  public getConnection(
    teamId: string,
    ownerUserId: string
  ): Promise<GmailConnectionRecord | null> {
    return this.options.repository.findConnection(teamId, ownerUserId);
  }

  public async disconnect(input: {
    readonly teamId: string;
    readonly ownerUserId: string;
    readonly requestId?: string;
  }): Promise<void> {
    const result = await this.options.repository.disconnect({
      teamId: input.teamId,
      ownerUserId: input.ownerUserId,
      requestId: input.requestId ?? null,
      now: this.now()
    });
    await this.revokeObsoleteToken(result.tokenToRevoke);
  }

  public markCredentialFailure(
    authorizationId: string,
    errorCode: string
  ): Promise<void> {
    return this.options.repository.markAuthorizationRequiresReauth({
      authorizationId,
      errorCode: sanitizeErrorCode(errorCode),
      now: this.now()
    });
  }

  private async revokeObsoleteToken(
    token: Parameters<TokenEncryptionProvider["decrypt"]>[0] | null,
    activeRefreshToken?: string
  ): Promise<void> {
    if (!token) {
      return;
    }
    try {
      const plaintext = await this.options.tokenEncryption.decrypt(token);
      if (plaintext === activeRefreshToken) {
        return;
      }
      await this.options.oauthProvider.revokeRefreshToken(plaintext);
    } catch {
      // Call Now has already disabled the credential. Google revocation is
      // deliberately best-effort and never re-enables local monitoring.
    }
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

function sanitizeErrorCode(value: string): string {
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_:-]/gu, "_");
  return normalized.slice(0, 100) || "GMAIL_CREDENTIAL_INVALID";
}

function invalidGmailAuthorizationError(): AppError {
  return new AppError(
    "GMAIL_AUTHORIZATION_INVALID_OR_EXPIRED",
    "Gmail連携が無効または期限切れです。もう一度お試しください。",
    401
  );
}
