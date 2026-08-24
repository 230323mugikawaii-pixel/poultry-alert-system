import { randomUUID } from "node:crypto";
import { AppError } from "../../src/lib/app-error.js";
import type {
  AuditEventRecord,
  InvitationLinkRecord,
  InvitationRecord,
  InvitationRepository,
  JoinResult,
  MemberRemovalResult,
  PublicInvitationRecord
} from "../../src/modules/invitations/invitation-repository.js";
import { calculateSeatSummary } from "../../src/modules/teams/seat-policy.js";
import type { MemoryTeamRepository } from "./memory-team.js";

interface StoredInvitation {
  id: string;
  teamId: string;
  teamCode: string;
  status: InvitationRecord["status"];
  passwordHash: string;
  maxUses: number;
  usedCount: number;
  expiresAt: Date;
  createdAt: Date;
  seatLimit: number;
  activeMemberCount: number;
  pendingSeatLimit: number | null;
  createdByUserId: string;
}

interface StoredLink {
  id: string;
  invitationId: string;
  tokenHash: string;
  status: InvitationRecord["status"];
  maxUses: number;
  usedCount: number;
  expiresAt: Date;
}

interface StoredGrant {
  secretHash: string;
  invitationId: string;
  linkId: string | null;
  expiresAt: Date;
  consumed: boolean;
}

export class MemoryInvitationRepository implements InvitationRepository {
  public readonly invitations: StoredInvitation[] = [];
  public readonly links: StoredLink[] = [];
  public readonly grants: StoredGrant[] = [];
  public readonly redemptions = new Map<
    string,
    JoinResult & { userId: string }
  >();
  public readonly auditEvents: AuditEventRecord[] = [];
  private gate: Promise<void> = Promise.resolve();

  public constructor(private readonly teams: MemoryTeamRepository) {}

  public async issuePasswordInvitation(input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly passwordHash: string;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<InvitationRecord> {
    return this.withLock(async () => {
      const context = this.requireTeam(input.teamId);
      this.requireOwner(input.actorUserId);
      this.expireStale(input.now);
      if (context.pendingSeatLimit !== null) {
        throw new AppError("INVITATIONS_SUSPENDED", "pending", 409);
      }
      const availableSeats = this.activeSeatSummary().availableSeats;
      if (availableSeats === 0) {
        throw invitationExhausted();
      }
      this.replaceActive(input.now);
      const invitation: StoredInvitation = {
        id: randomUUID(),
        teamId: context.teamId,
        teamCode: context.teamCode,
        status: "ACTIVE",
        passwordHash: input.passwordHash,
        maxUses: availableSeats,
        usedCount: 0,
        expiresAt: input.expiresAt,
        createdAt: input.now,
        seatLimit: context.seatSummary.seatLimit,
        activeMemberCount: this.activeSeatSummary().activeMemberCount,
        pendingSeatLimit: context.pendingSeatLimit,
        createdByUserId: input.actorUserId
      };
      this.invitations.push(invitation);
      return invitation;
    });
  }

  public async findPasswordInvitation(
    teamCode: string,
    now: Date
  ): Promise<InvitationRecord | null> {
    this.expireStale(now);
    const invitation = [...this.invitations]
      .reverse()
      .find((candidate) => candidate.teamCode === teamCode);
    return invitation ? this.refreshInvitation(invitation) : null;
  }

  public async createInvitationLink(input: {
    readonly invitationId: string;
    readonly actorUserId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<InvitationLinkRecord> {
    this.requireOwner(input.actorUserId);
    this.expireStale(input.now);
    const invitation = this.invitations.find(
      ({ id }) => id === input.invitationId
    );
    if (!invitation || invitation.status !== "ACTIVE") {
      throw invitationExhausted();
    }
    const link: StoredLink = {
      id: randomUUID(),
      invitationId: invitation.id,
      tokenHash: input.tokenHash,
      status: "ACTIVE",
      maxUses: 1,
      usedCount: 0,
      expiresAt: input.expiresAt
    };
    this.links.push(link);
    return this.mapLink(link, invitation);
  }

  public async findInvitationLink(
    tokenHash: string,
    now: Date
  ): Promise<InvitationLinkRecord | null> {
    this.expireStale(now);
    const link = this.links.find(
      (candidate) => candidate.tokenHash === tokenHash
    );
    const invitation = link
      ? this.invitations.find(({ id }) => id === link.invitationId)
      : null;
    return link && invitation ? this.mapLink(link, invitation) : null;
  }

  public async createJoinGrant(input: {
    readonly secretHash: string;
    readonly invitationId: string;
    readonly linkId: string | null;
    readonly expiresAt: Date;
  }): Promise<void> {
    this.grants.push({ ...input, consumed: false });
  }

  public async redeemJoinGrant(input: {
    readonly secretHash: string;
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly now: Date;
  }): Promise<JoinResult> {
    return this.withLock(async () => {
      this.expireStale(input.now);
      const previous = this.redemptions.get(input.idempotencyKey);
      if (previous) {
        if (previous.userId !== input.userId) {
          throw new AppError("IDEMPOTENCY_KEY_CONFLICT", "conflict", 409);
        }
        return previous;
      }
      const grant = this.grants.find(
        (candidate) =>
          candidate.secretHash === input.secretHash &&
          !candidate.consumed &&
          candidate.expiresAt > input.now
      );
      if (!grant) {
        throw invalidInvitation();
      }
      const invitation = this.invitations.find(
        ({ id }) => id === grant.invitationId
      );
      if (!invitation) {
        throw invalidInvitation();
      }
      const summary = this.activeSeatSummary();
      if (
        invitation.status !== "ACTIVE" ||
        invitation.expiresAt <= input.now ||
        invitation.usedCount >= invitation.maxUses ||
        summary.activeMemberCount >= summary.seatLimit ||
        this.teams.context?.pendingSeatLimit !== null
      ) {
        throw invitationExhausted();
      }
      const link = grant.linkId
        ? this.links.find(({ id }) => id === grant.linkId)
        : null;
      if (
        grant.linkId &&
        (!link ||
          link.status !== "ACTIVE" ||
          link.expiresAt <= input.now ||
          link.usedCount >= link.maxUses)
      ) {
        throw invalidInvitation();
      }
      if (this.teams.members.some(({ userId }) => userId === input.userId)) {
        throw new AppError("ALREADY_TEAM_MEMBER", "already joined", 409);
      }

      this.teams.addMember(input.userId);
      const membership = this.teams.members.find(
        ({ userId }) => userId === input.userId
      );
      if (!membership) {
        throw new Error("membership_creation_failed");
      }
      invitation.usedCount += 1;
      grant.consumed = true;
      const nextSummary = this.activeSeatSummary();
      if (
        invitation.usedCount >= invitation.maxUses ||
        nextSummary.activeMemberCount >= nextSummary.seatLimit
      ) {
        invitation.status = "EXHAUSTED";
      }
      if (link) {
        link.usedCount = 1;
        link.status = "EXHAUSTED";
      }
      if (nextSummary.activeMemberCount >= nextSummary.seatLimit) {
        for (const activeLink of this.links) {
          if (
            activeLink.invitationId === invitation.id &&
            activeLink.status === "ACTIVE"
          ) {
            activeLink.status = "EXHAUSTED";
          }
        }
      }
      const result: JoinResult & { userId: string } = {
        teamId: invitation.teamId,
        teamCode: invitation.teamCode,
        membershipId: membership.membershipId,
        activeMemberCount: nextSummary.activeMemberCount,
        seatLimit: nextSummary.seatLimit,
        availableSeats: nextSummary.availableSeats,
        userId: input.userId
      };
      this.redemptions.set(input.idempotencyKey, result);
      return result;
    });
  }

  public async listInvitations(
    _teamId: string,
    now: Date
  ): Promise<readonly PublicInvitationRecord[]> {
    this.expireStale(now);
    return [...this.invitations].reverse().map(toPublicInvitation);
  }

  public async revokeInvitation(input: {
    readonly teamId: string;
    readonly invitationId: string;
    readonly actorUserId: string;
    readonly now: Date;
  }): Promise<boolean> {
    this.requireOwner(input.actorUserId);
    const invitation = this.invitations.find(
      ({ id, teamId, status }) =>
        id === input.invitationId &&
        teamId === input.teamId &&
        status === "ACTIVE"
    );
    if (!invitation) return false;
    invitation.status = "REVOKED";
    return true;
  }

  public async revokeInvitationLink(input: {
    readonly teamId: string;
    readonly linkId: string;
    readonly actorUserId: string;
    readonly now: Date;
  }): Promise<boolean> {
    this.requireOwner(input.actorUserId);
    const link = this.links.find(
      ({ id, status }) => id === input.linkId && status === "ACTIVE"
    );
    const invitation = link
      ? this.invitations.find(({ id }) => id === link.invitationId)
      : null;
    if (!link || invitation?.teamId !== input.teamId) return false;
    link.status = "REVOKED";
    return true;
  }

  public async removeMemberAndReconcile(input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly membershipId: string;
    readonly replacementPasswordHash: string;
    readonly invitationExpiresAt: Date;
    readonly now: Date;
  }): Promise<MemberRemovalResult> {
    this.requireOwner(input.actorUserId);
    return this.removeMember({
      membershipId: input.membershipId,
      actorUserId: input.actorUserId,
      status: "REMOVED",
      replacementPasswordHash: input.replacementPasswordHash,
      invitationExpiresAt: input.invitationExpiresAt,
      now: input.now
    });
  }

  public async leaveTeamAndReconcile(input: {
    readonly userId: string;
    readonly now: Date;
  }): Promise<MemberRemovalResult> {
    const membership = this.teams.members.find(
      ({ userId }) => userId === input.userId
    );
    if (!membership) throw new AppError("TEAM_NOT_FOUND", "missing", 404);
    if (membership.role === "OWNER") {
      throw new AppError("OWNER_TRANSFER_REQUIRED", "owner", 409);
    }
    return this.removeMember({
      membershipId: membership.membershipId,
      actorUserId: input.userId,
      status: "LEFT",
      replacementPasswordHash: null,
      invitationExpiresAt: null,
      now: input.now
    });
  }

  public async listAuditEvents(): Promise<readonly AuditEventRecord[]> {
    return this.auditEvents;
  }

  private async removeMember(input: {
    membershipId: string;
    actorUserId: string;
    status: "REMOVED" | "LEFT";
    replacementPasswordHash: string | null;
    invitationExpiresAt: Date | null;
    now: Date;
  }): Promise<MemberRemovalResult> {
    return this.withLock(async () => {
      const index = this.teams.members.findIndex(
        ({ membershipId }) => membershipId === input.membershipId
      );
      const member = this.teams.members[index];
      if (!member || member.role !== "MEMBER") {
        throw new AppError("MEMBER_NOT_FOUND", "missing", 404);
      }
      this.teams.members.splice(index, 1);
      const context = this.requireTeam();
      let seatLimit = context.seatSummary.seatLimit;
      const activeMemberCount = this.teams.members.filter(
        ({ role }) => role === "MEMBER"
      ).length;
      let pendingSeatLimitApplied = false;
      if (
        context.pendingSeatLimit !== null &&
        activeMemberCount <= context.pendingSeatLimit
      ) {
        seatLimit = context.pendingSeatLimit;
        pendingSeatLimitApplied = true;
      }
      const summary = calculateSeatSummary(seatLimit, activeMemberCount);
      this.teams.context = {
        ...context,
        pendingSeatLimit: pendingSeatLimitApplied
          ? null
          : context.pendingSeatLimit,
        seatSummary: summary
      };
      this.replaceActive(input.now);

      let invitation: PublicInvitationRecord | null = null;
      if (
        input.replacementPasswordHash &&
        input.invitationExpiresAt &&
        summary.availableSeats > 0
      ) {
        const created: StoredInvitation = {
          id: randomUUID(),
          teamId: context.teamId,
          teamCode: context.teamCode,
          status: "ACTIVE",
          passwordHash: input.replacementPasswordHash,
          maxUses: summary.availableSeats,
          usedCount: 0,
          expiresAt: input.invitationExpiresAt,
          createdAt: input.now,
          seatLimit,
          activeMemberCount,
          pendingSeatLimit: null,
          createdByUserId: input.actorUserId
        };
        this.invitations.push(created);
        invitation = toPublicInvitation(created);
      }
      return {
        removedUserId: member.userId,
        activeMemberCount,
        seatLimit,
        availableSeats: summary.availableSeats,
        pendingSeatLimitApplied,
        invitation
      };
    });
  }

  private requireTeam(teamId?: string) {
    const context = this.teams.context;
    if (!context || (teamId && context.teamId !== teamId)) {
      throw new AppError("TEAM_NOT_FOUND", "missing", 404);
    }
    return context;
  }

  private requireOwner(userId: string): void {
    const owner = this.teams.members.find(
      (member) => member.userId === userId && member.role === "OWNER"
    );
    if (!owner) throw new AppError("OWNER_REQUIRED", "owner only", 403);
  }

  private activeSeatSummary() {
    const context = this.requireTeam();
    const activeMemberCount = this.teams.members.filter(
      ({ role }) => role === "MEMBER"
    ).length;
    return calculateSeatSummary(
      context.seatSummary.seatLimit,
      activeMemberCount
    );
  }

  private refreshInvitation(invitation: StoredInvitation): StoredInvitation {
    const summary = this.activeSeatSummary();
    invitation.seatLimit = summary.seatLimit;
    invitation.activeMemberCount = summary.activeMemberCount;
    invitation.pendingSeatLimit = this.teams.context?.pendingSeatLimit ?? null;
    return invitation;
  }

  private mapLink(
    link: StoredLink,
    invitation: StoredInvitation
  ): InvitationLinkRecord {
    return {
      id: link.id,
      invitationId: link.invitationId,
      status: link.status,
      maxUses: link.maxUses,
      usedCount: link.usedCount,
      expiresAt: link.expiresAt,
      invitation: this.refreshInvitation(invitation)
    };
  }

  private replaceActive(now: Date): void {
    for (const invitation of this.invitations) {
      if (invitation.status === "ACTIVE") {
        invitation.status = "REPLACED";
        for (const link of this.links) {
          if (link.invitationId === invitation.id && link.status === "ACTIVE") {
            link.status = "REPLACED";
          }
        }
      }
    }
    void now;
  }

  private expireStale(now: Date): void {
    const expiredInvitationIds = new Set<string>();
    for (const invitation of this.invitations) {
      if (invitation.status === "ACTIVE" && invitation.expiresAt <= now) {
        invitation.status = "EXPIRED";
        expiredInvitationIds.add(invitation.id);
      }
    }
    for (const link of this.links) {
      if (
        link.status === "ACTIVE" &&
        (link.expiresAt <= now || expiredInvitationIds.has(link.invitationId))
      ) {
        link.status = "EXPIRED";
      }
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.gate;
    let release = (): void => undefined;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function toPublicInvitation(
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

function invitationExhausted(): AppError {
  return new AppError("INVITATION_EXHAUSTED", "exhausted", 409);
}

function invalidInvitation(): AppError {
  return new AppError("INVITATION_INVALID_OR_EXPIRED", "invalid", 401);
}
