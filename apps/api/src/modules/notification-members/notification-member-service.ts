import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import { AppError } from "../../lib/app-error.js";
import {
  generateInvitationPassword,
  hashInvitationPassword,
  verifyInvitationPassword
} from "../invitations/invitation-credential.js";
import type { SecurityThrottleService } from "../security/security-throttle-service.js";
import type {
  NotificationMemberAuthentication,
  NotificationMemberListResult,
  NotificationMemberRecord,
  NotificationMemberRepository
} from "./notification-member-repository.js";

const CALL_NOW_ID_PATTERN = /^CN-[0-9A-HJKMNP-TV-Z]{8}$/u;
const CALL_NOW_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DUMMY_PASSWORD_HASH = hashInvitationPassword(
  "Call-Now-dummy-member-password-verification"
);

export interface NotificationMemberServiceOptions {
  readonly repository: NotificationMemberRepository;
  readonly securityThrottle: SecurityThrottleService;
  readonly tokenPepper: string;
  readonly sessionIdleDays: number;
  readonly sessionAbsoluteDays: number;
  readonly maxActiveSessions: number;
  readonly now?: () => Date;
  readonly callNowIdGenerator?: () => string;
}

export interface NotificationMemberLoginResult extends NotificationMemberAuthentication {
  readonly sessionToken: string;
}

export class NotificationMemberService {
  private readonly now: () => Date;
  private readonly callNowIdGenerator: () => string;

  public constructor(
    private readonly options: NotificationMemberServiceOptions
  ) {
    this.now = options.now ?? (() => new Date());
    this.callNowIdGenerator = options.callNowIdGenerator ?? generateCallNowId;
  }

  public list(teamId: string): Promise<NotificationMemberListResult> {
    return this.options.repository.list(teamId);
  }

  public async create(input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly displayName?: string;
  }): Promise<{
    readonly member: NotificationMemberRecord;
    readonly initialPassword: string;
  }> {
    const initialPassword = generateInvitationPassword();
    const passwordHash = await hashInvitationPassword(initialPassword);
    const displayName = input.displayName?.trim().slice(0, 120) || null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        return {
          member: await this.options.repository.create({
            teamId: input.teamId,
            actorUserId: input.actorUserId,
            callNowId: this.callNowIdGenerator(),
            displayName,
            passwordHash,
            now: this.now()
          }),
          initialPassword
        };
      } catch (error) {
        if (!isCallNowIdConflict(error)) throw error;
      }
    }
    throw new AppError(
      "CALL_NOW_ID_GENERATION_FAILED",
      "Call Now IDを発行できませんでした。もう一度お試しください。",
      503
    );
  }

  public async resetPassword(input: {
    readonly teamId: string;
    readonly memberId: string;
    readonly actorUserId: string;
  }): Promise<{
    readonly member: NotificationMemberRecord;
    readonly initialPassword: string;
  }> {
    const initialPassword = generateInvitationPassword();
    const member = await this.options.repository.replacePassword({
      ...input,
      passwordHash: await hashInvitationPassword(initialPassword),
      now: this.now()
    });
    return { member, initialPassword };
  }

  public disable(input: {
    readonly teamId: string;
    readonly memberId: string;
    readonly actorUserId: string;
  }): Promise<NotificationMemberListResult> {
    return this.options.repository.disable({ ...input, now: this.now() });
  }

  public async login(input: {
    readonly callNowId: string;
    readonly password: string;
    readonly ipAddress: string;
    readonly userAgent?: string;
  }): Promise<NotificationMemberLoginResult> {
    const callNowId = normalizeCallNowId(input.callNowId);
    const rules = loginThrottleRules(callNowId, input.ipAddress);
    await this.options.securityThrottle.assertFailuresAllowed(rules, {
      code: "NOTIFICATION_MEMBER_LOGIN_LOCKED",
      message:
        "ログイン試行回数が上限に達しました。時間をおいてお試しください。",
      statusCode: 429
    });
    const member = CALL_NOW_ID_PATTERN.test(callNowId)
      ? await this.options.repository.findByCallNowId(callNowId)
      : null;
    const valid = await verifyInvitationPassword(
      member?.passwordHash ?? (await DUMMY_PASSWORD_HASH),
      input.password
    );
    if (!member || member.status !== "ACTIVE" || !valid) {
      await this.options.securityThrottle.recordFailure(rules);
      throw invalidCredentialsError();
    }
    await this.options.securityThrottle.clear(rules);
    const now = this.now();
    const sessionToken = randomBytes(32).toString("base64url");
    const session = await this.options.repository.createSession({
      memberId: member.id,
      tokenHash: this.hashSecret(sessionToken),
      ipHash: this.hashMetadata(input.ipAddress),
      userAgentHash: input.userAgent
        ? this.hashMetadata(input.userAgent)
        : null,
      idleExpiresAt: addDays(now, this.options.sessionIdleDays),
      expiresAt: addDays(now, this.options.sessionAbsoluteDays),
      maxActiveSessions: this.options.maxActiveSessions,
      now
    });
    const authenticated = await this.options.repository.findActiveSession(
      this.hashSecret(sessionToken),
      now
    );
    if (!authenticated) throw invalidCredentialsError();
    return { ...authenticated, session, sessionToken };
  }

  public async authenticate(
    sessionToken: string
  ): Promise<NotificationMemberAuthentication> {
    if (!/^[A-Za-z0-9_-]{40,100}$/u.test(sessionToken)) {
      throw unauthenticatedError();
    }
    const now = this.now();
    const authenticated = await this.options.repository.findActiveSession(
      this.hashSecret(sessionToken),
      now
    );
    if (!authenticated) throw unauthenticatedError();
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

  public async logout(sessionToken: string): Promise<void> {
    if (/^[A-Za-z0-9_-]{40,100}$/u.test(sessionToken)) {
      await this.options.repository.revokeSession(
        this.hashSecret(sessionToken),
        this.now()
      );
    }
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

export function generateCallNowId(): string {
  let suffix = "";
  for (let index = 0; index < 8; index += 1) {
    suffix += CALL_NOW_ID_ALPHABET[randomInt(0, CALL_NOW_ID_ALPHABET.length)];
  }
  return `CN-${suffix}`;
}

export function normalizeCallNowId(value: string): string {
  return value.trim().toUpperCase();
}

function loginThrottleRules(callNowId: string, ipAddress: string) {
  return [
    {
      scope: "member_login_source",
      dimensions: [ipAddress],
      maximumAttempts: 20,
      windowMinutes: 15,
      lockMinutes: 15
    },
    {
      scope: "member_login_id",
      dimensions: [callNowId],
      maximumAttempts: 8,
      windowMinutes: 15,
      lockMinutes: 30
    },
    {
      scope: "member_login_pair",
      dimensions: [callNowId, ipAddress],
      maximumAttempts: 5,
      windowMinutes: 15,
      lockMinutes: 30
    }
  ];
}

function invalidCredentialsError(): AppError {
  return new AppError(
    "NOTIFICATION_MEMBER_LOGIN_FAILED",
    "Call Now IDまたはパスワードを確認してください。",
    401
  );
}

function unauthenticatedError(): AppError {
  return new AppError("UNAUTHENTICATED", "ログインが必要です。", 401);
}

function isCallNowIdConflict(error: unknown): boolean {
  return error instanceof AppError && error.code === "CALL_NOW_ID_CONFLICT";
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

function minDate(first: Date, second: Date): Date {
  return first.getTime() <= second.getTime() ? first : second;
}
