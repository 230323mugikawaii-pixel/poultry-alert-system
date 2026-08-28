import type { SeatSummary } from "./seat-policy.js";

export type TeamRole = "OWNER" | "MEMBER";
export type SubscriptionState = "ACTIVE" | "PAST_DUE" | "CANCELED";

export interface TeamContextRecord {
  readonly teamId: string;
  readonly teamCode: string;
  readonly teamName: string | null;
  readonly membershipId: string;
  readonly role: TeamRole;
  readonly seatSummary: SeatSummary;
  readonly pendingSeatLimit: number | null;
  readonly subscriptionStatus: SubscriptionState;
  readonly currentTermAmountYen: number;
  readonly currentTermStartedAt: Date;
  readonly currentTermEndsAt: Date;
}

export interface TeamMemberRecord {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly role: TeamRole;
  readonly joinedAt: Date;
}

export interface CreateTeamInput {
  readonly ownerUserId: string;
  readonly publicCode: string;
  readonly name: string | null;
  readonly seatLimit: number;
  readonly keywords: readonly string[];
  readonly currentTermStartedAt: Date;
  readonly currentTermEndsAt: Date;
  readonly currentTermAmountYen: number;
  readonly initialInvitation: InvitationDraft | null;
}

export interface InvitationDraft {
  readonly passwordHash: string;
  readonly expiresAt: Date;
}

export interface IssuedInvitationRecord {
  readonly id: string;
  readonly maxUses: number;
  readonly usedCount: number;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface TeamCreationResult {
  readonly team: TeamContextRecord;
  readonly invitation: IssuedInvitationRecord | null;
}

export interface SeatLimitChangeResult {
  readonly changeId: string;
  readonly status: "AWAITING_PAYMENT" | "PENDING_CAPACITY" | "APPLIED";
  readonly previousSeatLimit: number;
  readonly requestedSeatLimit: number;
  readonly activeMemberCount: number;
  readonly availableSeats: number;
  readonly invitation: IssuedInvitationRecord | null;
}

export interface TeamRepository {
  createTeam(input: CreateTeamInput): Promise<TeamCreationResult>;
  completeOwnerOnboardingPurchase(
    input: CreateTeamInput & {
      readonly onboardingId: string;
    }
  ): Promise<TeamCreationResult>;
  ensureInitialTeam(input: CreateTeamInput): Promise<TeamContextRecord>;
  findCurrentTeam(userId: string): Promise<TeamContextRecord | null>;
  findTeamForUser(
    userId: string,
    teamId: string
  ): Promise<TeamContextRecord | null>;
  listActiveMembers(teamId: string): Promise<readonly TeamMemberRecord[]>;
  requestSeatLimitChange(input: {
    readonly teamId: string;
    readonly requestedByUserId: string;
    readonly requestedSeatLimit: number;
    readonly now: Date;
    readonly replacementInvitation: InvitationDraft | null;
  }): Promise<SeatLimitChangeResult>;
  applyPaidSeatIncrease(input: {
    readonly changeId: string;
    readonly paymentEventId: string;
    readonly now: Date;
    readonly invitation: InvitationDraft;
  }): Promise<SeatLimitChangeResult>;
}
