import type { SeatSummary } from "./seat-policy.js";

export type TeamRole = "OWNER" | "MEMBER";

export interface TeamContextRecord {
  readonly teamId: string;
  readonly teamCode: string;
  readonly teamName: string | null;
  readonly membershipId: string;
  readonly role: TeamRole;
  readonly seatSummary: SeatSummary;
  readonly pendingSeatLimit: number | null;
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
}

export interface SeatLimitChangeResult {
  readonly changeId: string;
  readonly status: "AWAITING_PAYMENT" | "PENDING_CAPACITY" | "APPLIED";
  readonly previousSeatLimit: number;
  readonly requestedSeatLimit: number;
  readonly activeMemberCount: number;
  readonly availableSeats: number;
}

export interface TeamRepository {
  createTeam(input: CreateTeamInput): Promise<TeamContextRecord>;
  findCurrentTeam(userId: string): Promise<TeamContextRecord | null>;
  listActiveMembers(teamId: string): Promise<readonly TeamMemberRecord[]>;
  requestSeatLimitChange(input: {
    readonly teamId: string;
    readonly requestedByUserId: string;
    readonly requestedSeatLimit: number;
    readonly now: Date;
  }): Promise<SeatLimitChangeResult>;
  applyPaidSeatIncrease(input: {
    readonly changeId: string;
    readonly now: Date;
  }): Promise<SeatLimitChangeResult>;
}
