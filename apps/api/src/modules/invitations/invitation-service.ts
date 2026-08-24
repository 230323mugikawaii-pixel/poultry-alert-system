import { createHmac, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { AppError } from "../../lib/app-error.js";
import type {
  SecurityThrottleRule,
  SecurityThrottleService
} from "../security/security-throttle-service.js";
import type { TeamService } from "../teams/team-service.js";
import type {
  AuditEventRecord,
  InvitationRecord,
  InvitationRepository,
  JoinResult,
  MemberRemovalResult,
  PublicInvitationRecord
} from "./invitation-repository.js";

const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1
} as const;

export interface InvitationServiceOptions {
  readonly repository: InvitationRepository;
  readonly teamService: TeamService;
  readonly publicOrigin: string;
  readonly tokenPepper: string;
  readonly invitationTtlDays: number;
  readonly joinGrantTtlMinutes: number;
  readonly lineLinkTtlHours: number;
  readonly securityThrottle: SecurityThrottleService;
  readonly now?: () => Date;
}

export class InvitationService {
  private readonly now: () => Date;
  private readonly dummyPasswordHash: Promise<string>;

  public constructor(private readonly options: InvitationServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.dummyPasswordHash = argon2.hash(
      "call-now-dummy-invitation-password",
      ARGON_OPTIONS
    );
  }

  public async reissuePasswordInvitation(userId: string): Promise<{
    readonly invitation: PublicInvitationRecord;
    readonly password: string;
  }> {
    const context = await this.options.teamService.requireOwner(userId);
    return this.issueForTeam(context.teamId, userId);
  }

  public async issueForTeam(
    teamId: string,
    actorUserId: string
  ): Promise<{
    readonly invitation: PublicInvitationRecord;
    readonly password: string;
  }> {
    const now = this.now();
    const password = generateInvitationPassword();
    const invitation = await this.options.repository.issuePasswordInvitation({
      teamId,
      actorUserId,
      passwordHash: await argon2.hash(password, ARGON_OPTIONS),
      expiresAt: addDays(now, this.options.invitationTtlDays),
      now
    });
    return { invitation: publicInvitation(invitation), password };
  }

  public async verifyPasswordInvitation(input: {
    readonly teamCode: string;
    readonly password: string;
    readonly attemptKey: string;
  }): Promise<{ readonly joinToken: string; readonly expiresAt: Date }> {
    const teamCode = input.teamCode.trim();
    if (!/^\d{6}$/.test(teamCode)) {
      throw invalidInvitationError();
    }
    const now = this.now();
    const invitation = await this.options.repository.findPasswordInvitation(
      teamCode,
      now
    );
    const throttleRules = passwordThrottleRules(
      invitation?.id ?? `team:${teamCode}`,
      input.attemptKey
    );
    const throttleError = {
      code: "INVITATION_TEMPORARILY_LOCKED",
      message: "入力回数が上限に達しました。しばらく待ってからお試しください。",
      statusCode: 429
    } as const;
    await this.options.securityThrottle.assertFailuresAllowed(
      throttleRules,
      throttleError
    );
    const passwordHash =
      invitation?.passwordHash ?? (await this.dummyPasswordHash);
    const verified = await argon2
      .verify(passwordHash, input.password)
      .catch(() => false);
    if (!verified || !invitation) {
      await this.options.securityThrottle.recordFailure(throttleRules);
      throw invalidInvitationError();
    }

    await this.options.securityThrottle.clear([throttleRules[0]]);
    assertInvitationUsable(invitation, now);
    return this.createJoinGrant(invitation.id, null, now);
  }

  public async createLineInvitationLink(
    userId: string,
    invitationId?: string
  ): Promise<{
    readonly linkId: string;
    readonly invitationLink: string;
    readonly shareText: string;
    readonly expiresAt: Date;
  }> {
    const context = await this.options.teamService.requireOwner(userId);
    const invitations = await this.options.repository.listInvitations(
      context.teamId,
      this.now()
    );
    let current = invitations.find((invitation) =>
      invitationId
        ? invitation.id === invitationId && invitation.status === "ACTIVE"
        : invitation.status === "ACTIVE" && invitation.expiresAt > this.now()
    );
    if (invitationId && !current) {
      throw new AppError("INVITATION_NOT_FOUND", "招待が見つかりません。", 404);
    }
    if (!current) {
      current = (await this.issueForTeam(context.teamId, userId)).invitation;
    }

    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const link = await this.options.repository.createInvitationLink({
      invitationId: current.id,
      actorUserId: userId,
      tokenHash: this.hashSecret(token),
      expiresAt: addHours(now, this.options.lineLinkTtlHours),
      now
    });
    const invitationUrl = new URL("/join", this.options.publicOrigin);
    invitationUrl.searchParams.set("token", token);

    return {
      linkId: link.id,
      invitationLink: invitationUrl.toString(),
      shareText: [
        "Call Nowのチームへ招待されました。",
        `チームID：${context.teamCode}`,
        "以下のリンクから参加してください。",
        invitationUrl.toString()
      ].join("\n"),
      expiresAt: link.expiresAt
    };
  }

  public async verifyLineInvitation(token: string): Promise<{
    readonly joinToken: string;
    readonly expiresAt: Date;
  }> {
    if (!isPlausibleToken(token)) {
      throw invalidInvitationError();
    }
    const now = this.now();
    const link = await this.options.repository.findInvitationLink(
      this.hashSecret(token),
      now
    );
    if (!link) {
      throw invalidInvitationError();
    }
    assertInvitationUsable(link.invitation, now);
    if (
      link.status !== "ACTIVE" ||
      link.expiresAt <= now ||
      link.usedCount >= link.maxUses
    ) {
      throw invalidInvitationError();
    }
    return this.createJoinGrant(link.invitationId, link.id, now);
  }

  public async completeJoin(input: {
    readonly userId: string;
    readonly joinToken: string;
    readonly idempotencyKey: string;
  }): Promise<JoinResult> {
    if (
      !isPlausibleToken(input.joinToken) ||
      !/^[A-Za-z0-9_-]{16,100}$/.test(input.idempotencyKey)
    ) {
      throw invalidInvitationError();
    }
    return this.options.repository.redeemJoinGrant({
      secretHash: this.hashSecret(input.joinToken),
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      now: this.now()
    });
  }

  public async listInvitations(
    userId: string
  ): Promise<readonly PublicInvitationRecord[]> {
    const context = await this.options.teamService.requireOwner(userId);
    return this.options.repository.listInvitations(context.teamId, this.now());
  }

  public async revokeInvitation(
    userId: string,
    invitationId: string
  ): Promise<void> {
    const context = await this.options.teamService.requireOwner(userId);
    const revoked = await this.options.repository.revokeInvitation({
      teamId: context.teamId,
      invitationId,
      actorUserId: userId,
      now: this.now()
    });
    if (!revoked) {
      throw new AppError("INVITATION_NOT_FOUND", "招待が見つかりません。", 404);
    }
  }

  public async revokeInvitationLink(
    userId: string,
    linkId: string
  ): Promise<void> {
    const context = await this.options.teamService.requireOwner(userId);
    const revoked = await this.options.repository.revokeInvitationLink({
      teamId: context.teamId,
      linkId,
      actorUserId: userId,
      now: this.now()
    });
    if (!revoked) {
      throw new AppError(
        "INVITATION_LINK_NOT_FOUND",
        "招待リンクが見つかりません。",
        404
      );
    }
  }

  public async removeMember(
    ownerUserId: string,
    membershipId: string
  ): Promise<
    MemberRemovalResult & { readonly invitationPassword: string | null }
  > {
    const context = await this.options.teamService.requireOwner(ownerUserId);
    const password = generateInvitationPassword();
    const now = this.now();
    const result = await this.options.repository.removeMemberAndReconcile({
      teamId: context.teamId,
      actorUserId: ownerUserId,
      membershipId,
      replacementPasswordHash: await argon2.hash(password, ARGON_OPTIONS),
      invitationExpiresAt: addDays(now, this.options.invitationTtlDays),
      now
    });
    return {
      ...result,
      invitationPassword: result.invitation ? password : null
    };
  }

  public async leaveTeam(
    userId: string
  ): Promise<MemberRemovalResult & { readonly invitationPassword: null }> {
    const now = this.now();
    const result = await this.options.repository.leaveTeamAndReconcile({
      userId,
      now
    });
    return { ...result, invitationPassword: null };
  }

  public async listAuditEvents(
    userId: string
  ): Promise<readonly AuditEventRecord[]> {
    const context = await this.options.teamService.requireOwner(userId);
    return this.options.repository.listAuditEvents(context.teamId);
  }

  private async createJoinGrant(
    invitationId: string,
    linkId: string | null,
    now: Date
  ): Promise<{ readonly joinToken: string; readonly expiresAt: Date }> {
    const joinToken = randomBytes(32).toString("base64url");
    const expiresAt = addMinutes(now, this.options.joinGrantTtlMinutes);
    await this.options.repository.createJoinGrant({
      secretHash: this.hashSecret(joinToken),
      invitationId,
      linkId,
      expiresAt
    });
    return { joinToken, expiresAt };
  }

  private hashSecret(value: string): string {
    return createHmac("sha256", this.options.tokenPepper)
      .update(value, "utf8")
      .digest("hex");
  }
}

function passwordThrottleRules(
  invitationId: string,
  source: string
): readonly [SecurityThrottleRule, SecurityThrottleRule, SecurityThrottleRule] {
  return [
    {
      scope: "invite_pwd_pair",
      dimensions: [invitationId, source],
      maximumAttempts: 5,
      windowMinutes: 15,
      lockMinutes: 15
    },
    {
      scope: "invite_pwd_invite",
      dimensions: [invitationId],
      maximumAttempts: 50,
      windowMinutes: 15,
      lockMinutes: 30
    },
    {
      scope: "invite_pwd_source",
      dimensions: [source],
      maximumAttempts: 50,
      windowMinutes: 60,
      lockMinutes: 60
    }
  ];
}

export function generateInvitationPassword(): string {
  return randomBytes(18).toString("base64url");
}

function publicInvitation(
  invitation: InvitationRecord
): PublicInvitationRecord {
  return {
    id: invitation.id,
    status: invitation.status,
    maxUses: invitation.maxUses,
    usedCount: invitation.usedCount,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt
  };
}

function assertInvitationUsable(invitation: InvitationRecord, now: Date): void {
  if (
    invitation.status === "EXHAUSTED" ||
    invitation.usedCount >= invitation.maxUses ||
    invitation.activeMemberCount >= invitation.seatLimit
  ) {
    throw new AppError(
      "INVITATION_EXHAUSTED",
      "この招待は利用上限に達しました。チームの代表者にお問い合わせください。",
      409
    );
  }
  if (invitation.pendingSeatLimit !== null) {
    throw new AppError(
      "INVITATIONS_SUSPENDED",
      "契約人数の変更処理中のため、新しいメンバーは参加できません。",
      409
    );
  }
  if (invitation.status !== "ACTIVE" || invitation.expiresAt <= now) {
    throw invalidInvitationError();
  }
}

function invalidInvitationError(): AppError {
  return new AppError(
    "INVITATION_INVALID_OR_EXPIRED",
    "招待情報が正しくないか、有効期限が切れています。",
    401
  );
}

function isPlausibleToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{40,100}$/.test(value);
}

function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * 60_000);
}

function addHours(value: Date, hours: number): Date {
  return new Date(value.getTime() + hours * 3_600_000);
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}
