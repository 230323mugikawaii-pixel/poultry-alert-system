export type InvitationState =
  "ACTIVE" | "EXHAUSTED" | "EXPIRED" | "REVOKED" | "REPLACED";

export interface InvitationRecord {
  readonly id: string;
  readonly teamId: string;
  readonly teamCode: string;
  readonly status: InvitationState;
  readonly passwordHash: string;
  readonly maxUses: number;
  readonly usedCount: number;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly seatLimit: number;
  readonly activeMemberCount: number;
  readonly pendingSeatLimit: number | null;
}

export interface InvitationLinkRecord {
  readonly id: string;
  readonly invitationId: string;
  readonly status: InvitationState;
  readonly maxUses: number;
  readonly usedCount: number;
  readonly expiresAt: Date;
  readonly invitation: InvitationRecord;
}

export interface PublicInvitationRecord {
  readonly id: string;
  readonly status: InvitationState;
  readonly maxUses: number;
  readonly usedCount: number;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface JoinResult {
  readonly teamId: string;
  readonly teamCode: string;
  readonly membershipId: string;
  readonly activeMemberCount: number;
  readonly seatLimit: number;
  readonly availableSeats: number;
}

export interface MemberRemovalResult {
  readonly removedUserId: string;
  readonly activeMemberCount: number;
  readonly seatLimit: number;
  readonly availableSeats: number;
  readonly pendingSeatLimitApplied: boolean;
  readonly invitation: PublicInvitationRecord | null;
}

export interface AuditEventRecord {
  readonly id: string;
  readonly action: string;
  readonly actorUserId: string | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly metadata: unknown;
  readonly createdAt: Date;
}

export interface InvitationRepository {
  issuePasswordInvitation(input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly passwordHash: string;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<InvitationRecord>;
  findPasswordInvitation(
    teamCode: string,
    now: Date
  ): Promise<InvitationRecord | null>;
  createInvitationLink(input: {
    readonly invitationId: string;
    readonly actorUserId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<InvitationLinkRecord>;
  findInvitationLink(
    tokenHash: string,
    now: Date
  ): Promise<InvitationLinkRecord | null>;
  createJoinGrant(input: {
    readonly secretHash: string;
    readonly invitationId: string;
    readonly linkId: string | null;
    readonly expiresAt: Date;
  }): Promise<void>;
  redeemJoinGrant(input: {
    readonly secretHash: string;
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly now: Date;
  }): Promise<JoinResult>;
  listInvitations(
    teamId: string,
    now: Date
  ): Promise<readonly PublicInvitationRecord[]>;
  revokeInvitation(input: {
    readonly teamId: string;
    readonly invitationId: string;
    readonly actorUserId: string;
    readonly now: Date;
  }): Promise<boolean>;
  revokeInvitationLink(input: {
    readonly teamId: string;
    readonly linkId: string;
    readonly actorUserId: string;
    readonly now: Date;
  }): Promise<boolean>;
  removeMemberAndReconcile(input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly membershipId: string;
    readonly replacementPasswordHash: string;
    readonly invitationExpiresAt: Date;
    readonly now: Date;
  }): Promise<MemberRemovalResult>;
  leaveTeamAndReconcile(input: {
    readonly userId: string;
    readonly now: Date;
  }): Promise<MemberRemovalResult>;
  listAuditEvents(teamId: string): Promise<readonly AuditEventRecord[]>;
}
