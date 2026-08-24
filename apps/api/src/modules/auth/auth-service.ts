import { createHash, createHmac, randomBytes } from "node:crypto";
import { AppError } from "../../lib/app-error.js";
import type {
  AuthRepository,
  AuthSessionRecord,
  AuthUserRecord
} from "./auth-repository.js";
import type { MagicLinkEmailSender } from "./email-sender.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AuthServiceOptions {
  readonly repository: AuthRepository;
  readonly emailSender: MagicLinkEmailSender;
  readonly publicOrigin: string;
  readonly tokenPepper: string;
  readonly magicLinkTtlMinutes: number;
  readonly sessionIdleDays: number;
  readonly sessionAbsoluteDays: number;
  readonly maxActiveSessions: number;
  readonly now?: () => Date;
}

export interface ClientContext {
  readonly deviceName?: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface AuthenticatedSession {
  readonly user: AuthUserRecord;
  readonly session: AuthSessionRecord;
}

export interface MagicLinkLoginResult extends AuthenticatedSession {
  readonly sessionToken: string;
}

export class AuthService {
  private readonly now: () => Date;

  public constructor(private readonly options: AuthServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public async requestMagicLink(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    if (!EMAIL_PATTERN.test(email) || email.length > 320) {
      throw new AppError(
        "INVALID_EMAIL",
        "メールアドレスを確認してください。",
        400
      );
    }

    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const expiresAt = addMinutes(now, this.options.magicLinkTtlMinutes);

    await this.options.repository.createMagicLinkChallenge({
      email,
      secretHash: this.hashSecret(token),
      expiresAt
    });

    const magicLink = new URL("/auth/magic-link", this.options.publicOrigin);
    magicLink.searchParams.set("token", token);

    await this.options.emailSender.sendMagicLink({
      recipient: email,
      magicLink: magicLink.toString(),
      expiresInMinutes: this.options.magicLinkTtlMinutes
    });
  }

  public async consumeMagicLink(
    token: string,
    context: ClientContext
  ): Promise<MagicLinkLoginResult> {
    if (!isPlausibleToken(token)) {
      throw invalidMagicLinkError();
    }

    const now = this.now();
    const user = await this.options.repository.consumeMagicLink(
      this.hashSecret(token),
      now
    );

    if (!user || user.status !== "ACTIVE") {
      throw invalidMagicLinkError();
    }

    const sessionToken = randomBytes(32).toString("base64url");
    const session = await this.options.repository.createSession({
      userId: user.id,
      tokenHash: this.hashSecret(sessionToken),
      deviceName: context.deviceName?.trim().slice(0, 120) || null,
      ipHash: context.ipAddress ? this.hashMetadata(context.ipAddress) : null,
      userAgentHash: context.userAgent
        ? this.hashMetadata(context.userAgent)
        : null,
      idleExpiresAt: addDays(now, this.options.sessionIdleDays),
      expiresAt: addDays(now, this.options.sessionAbsoluteDays),
      maxActiveSessions: this.options.maxActiveSessions
    });

    return { user, session, sessionToken };
  }

  public async authenticate(
    sessionToken: string
  ): Promise<AuthenticatedSession> {
    if (!isPlausibleToken(sessionToken)) {
      throw unauthenticatedError();
    }

    const now = this.now();
    const authenticated = await this.options.repository.findActiveSession(
      this.hashSecret(sessionToken),
      now
    );

    if (!authenticated || authenticated.user.status !== "ACTIVE") {
      throw unauthenticatedError();
    }

    await this.options.repository.touchSession(
      authenticated.session.id,
      now,
      minDate(
        addDays(now, this.options.sessionIdleDays),
        authenticated.session.expiresAt
      )
    );

    return authenticated;
  }

  public async listSessions(
    userId: string,
    currentSessionId: string
  ): Promise<readonly AuthSessionRecord[]> {
    return (await this.options.repository.listSessions(userId)).map(
      (session) => ({
        ...session,
        current: session.id === currentSessionId
      })
    );
  }

  public async revokeSession(userId: string, sessionId: string): Promise<void> {
    const revoked = await this.options.repository.revokeSession(
      userId,
      sessionId,
      this.now()
    );
    if (!revoked) {
      throw new AppError(
        "SESSION_NOT_FOUND",
        "セッションが見つかりません。",
        404
      );
    }
  }

  public async revokeAllSessions(userId: string): Promise<void> {
    await this.options.repository.revokeAllSessions(userId, this.now());
  }

  private hashSecret(value: string): string {
    return createHmac("sha256", this.options.tokenPepper)
      .update(value, "utf8")
      .digest("hex");
  }

  private hashMetadata(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isPlausibleToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{40,100}$/.test(value);
}

function invalidMagicLinkError(): AppError {
  return new AppError(
    "MAGIC_LINK_INVALID_OR_EXPIRED",
    "ログインリンクが無効または期限切れです。",
    401
  );
}

function unauthenticatedError(): AppError {
  return new AppError("UNAUTHENTICATED", "ログインが必要です。", 401);
}

function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * 60_000);
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

function minDate(first: Date, second: Date): Date {
  return first.getTime() <= second.getTime() ? first : second;
}
