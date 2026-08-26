import { createHash, createHmac, randomBytes } from "node:crypto";
import { AppError } from "../../lib/app-error.js";
import type { AuthRepository, AuthUserRecord } from "./auth-repository.js";
import {
  normalizeEmail,
  type AuthService,
  type ClientContext,
  type MagicLinkLoginResult
} from "./auth-service.js";
import type { GoogleOAuthProvider } from "./google-oauth-client.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface GoogleAuthServiceOptions {
  readonly repository: AuthRepository;
  readonly authService: AuthService;
  readonly oauthProvider: GoogleOAuthProvider;
  readonly tokenPepper: string;
  readonly stateTtlMinutes: number;
  readonly now?: () => Date;
}

export interface GoogleAuthorizationRequest {
  readonly state: string;
  readonly authorizationUrl: string;
  readonly expiresAt: Date;
}

export class GoogleAuthService {
  private readonly now: () => Date;

  public constructor(private readonly options: GoogleAuthServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public async createAuthorizationRequest(): Promise<GoogleAuthorizationRequest> {
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier, "utf8")
      .digest("base64url");
    const expiresAt = addMinutes(this.now(), this.options.stateTtlMinutes);

    await this.options.repository.createGoogleOAuthChallenge({
      secretHash: this.hashSecret(state),
      codeVerifier,
      nonce,
      expiresAt
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

  public async completeAuthorization(
    state: string,
    code: string,
    context: ClientContext
  ): Promise<MagicLinkLoginResult> {
    if (!isPlausibleState(state) || !isPlausibleCode(code)) {
      throw invalidGoogleLoginError();
    }

    const challenge = await this.options.repository.consumeGoogleOAuthChallenge(
      this.hashSecret(state),
      this.now()
    );
    if (!challenge) {
      throw invalidGoogleLoginError();
    }

    let profile;
    try {
      profile = await this.options.oauthProvider.exchangeCode({
        code,
        codeVerifier: challenge.codeVerifier,
        expectedNonce: challenge.nonce
      });
    } catch {
      throw invalidGoogleLoginError();
    }

    const email = normalizeEmail(profile.email);
    if (
      !profile.emailVerified ||
      !EMAIL_PATTERN.test(email) ||
      email.length > 320 ||
      !profile.subject ||
      profile.subject.length > 255
    ) {
      throw invalidGoogleLoginError();
    }

    const user = await this.options.repository.resolveGoogleUser({
      providerSubject: profile.subject,
      email,
      displayName: normalizeDisplayName(profile.displayName),
      emailVerified: true,
      now: this.now()
    });
    return this.createSession(user, context);
  }

  private createSession(
    user: AuthUserRecord,
    context: ClientContext
  ): Promise<MagicLinkLoginResult> {
    return this.options.authService.createSessionForVerifiedUser(user, context);
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

function normalizeDisplayName(value: string | null): string | null {
  return value?.trim().slice(0, 120) || null;
}

function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * 60_000);
}

function invalidGoogleLoginError(): AppError {
  return new AppError(
    "GOOGLE_LOGIN_INVALID_OR_EXPIRED",
    "Googleログインが無効または期限切れです。もう一度お試しください。",
    401
  );
}
