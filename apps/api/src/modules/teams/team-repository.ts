import type { SeatSummary } from "./seat-policy.js";

export type TeamRole = "OWNER" | "MEMBER";
export type SubscriptionState = "ACTIVE" | "PAST_DUE" | "CANCELED";

export interface TeamContextRecord {
  readonly teamId: string;
  readonly teamCode: string;
  readonly teamName: string | null;
  readonly membershipId: string;
  readonly role: TeamRole;
  readonly keywords: readonly string[];
  readonly seatSummary: SeatSummary;
  readonly pendingSeatLimit: number | null;
  readonly subscriptionStatus: SubscriptionState;
  readonly currentTermAmountYen: number;
  readonly renewalAmountYen: number;
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

export interface ContractConnectionSettings {
  readonly connectionId: string;
  readonly keywords: readonly string[];
}

export interface ContractChangeQuoteRecord {
  readonly id: string;
  readonly status: "PENDING" | "APPLIED";
  readonly previousAnnualAmountYen: number;
  readonly nextAnnualAmountYen: number;
  readonly additionalChargeYen: number;
  readonly seatCount: number;
  readonly keywordCount: number;
  readonly mailConnectionCount: number;
  readonly expiresAt: Date;
}

export interface AppliedContractChangeRecord {
  readonly quote: ContractChangeQuoteRecord;
  readonly team: TeamContextRecord;
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
  updateContractSettings(input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly seatLimit: number;
    readonly keywords: readonly string[];
    readonly connectionKeywords: readonly {
      readonly connectionId: string;
      readonly keywords: readonly string[];
    }[];
    readonly currentTermAmountYen: number;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<TeamContextRecord>;
  createContractChangeQuote(input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly seatLimit: number;
    readonly keywords: readonly string[];
    readonly connectionKeywords: readonly ContractConnectionSettings[];
    readonly idempotencyKey: string;
    readonly now: Date;
    readonly expiresAt: Date;
  }): Promise<ContractChangeQuoteRecord>;
  applyContractChangeQuote(input: {
    readonly teamId: string;
    readonly quoteId: string;
    readonly actorUserId: string;
    readonly applyIdempotencyKey: string;
    readonly expectedPreviousAnnualAmountYen: number;
    readonly expectedNextAnnualAmountYen: number;
    readonly expectedAdditionalChargeYen: number;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<AppliedContractChangeRecord>;
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
