import { randomUUID } from "node:crypto";
import { AppError } from "../../src/lib/app-error.js";
import { calculateSeatSummary } from "../../src/modules/teams/seat-policy.js";
import type {
  AppliedContractChangeRecord,
  ContractChangeQuoteRecord,
  ContractConnectionSettings,
  CreateTeamInput,
  InvitationDraft,
  IssuedInvitationRecord,
  SeatLimitChangeResult,
  TeamCreationResult,
  TeamContextRecord,
  TeamMemberRecord,
  TeamRepository
} from "../../src/modules/teams/team-repository.js";

interface StoredChange {
  teamId: string;
  changeId: string;
  status: SeatLimitChangeResult["status"];
  previousSeatLimit: number;
  requestedSeatLimit: number;
  activeMemberCount: number;
  availableSeats: number;
  invitation: IssuedInvitationRecord | null;
  paymentEventId: string | null;
}

interface StoredContractQuote extends ContractChangeQuoteRecord {
  readonly teamId: string;
  readonly actorUserId: string;
  readonly seatLimit: number;
  readonly keywords: readonly string[];
  readonly connectionKeywords: readonly ContractConnectionSettings[];
  readonly idempotencyKey: string;
  readonly applyIdempotencyKey: string | null;
}

export class MemoryTeamRepository implements TeamRepository {
  public context: TeamContextRecord | null = null;
  public members: TeamMemberRecord[] = [];
  public changes: StoredChange[] = [];
  public invitations: IssuedInvitationRecord[] = [];
  public contractQuotes: StoredContractQuote[] = [];
  public failNextTeamCode = false;
  public teamCreationCount = 0;

  public async createTeam(input: CreateTeamInput): Promise<TeamCreationResult> {
    if (input.seatLimit > 0 && !input.initialInvitation) {
      throw new Error("initial_invitation_required");
    }
    return this.storeTeam(input);
  }

  private async storeTeam(input: CreateTeamInput): Promise<TeamCreationResult> {
    if (this.failNextTeamCode) {
      this.failNextTeamCode = false;
      throw new AppError("TEAM_CODE_CONFLICT", "collision", 409);
    }
    if (this.context) {
      throw new AppError("ALREADY_TEAM_MEMBER", "already joined", 409);
    }
    const teamId = randomUUID();
    const membershipId = randomUUID();
    this.teamCreationCount += 1;
    this.context = {
      teamId,
      teamCode: input.publicCode,
      teamName: input.name,
      membershipId,
      role: "OWNER",
      keywords: [...input.keywords],
      seatSummary: calculateSeatSummary(input.seatLimit, 0),
      pendingSeatLimit: null,
      subscriptionStatus: "ACTIVE",
      currentTermAmountYen: input.currentTermAmountYen,
      renewalAmountYen: input.currentTermAmountYen,
      currentTermStartedAt: input.currentTermStartedAt,
      currentTermEndsAt: input.currentTermEndsAt
    };
    this.members = [
      {
        membershipId,
        userId: input.ownerUserId,
        email: "owner@example.com",
        displayName: null,
        role: "OWNER",
        joinedAt: input.currentTermStartedAt
      }
    ];
    const invitation =
      input.initialInvitation && input.seatLimit > 0
        ? this.createInvitation(input.seatLimit, input.initialInvitation)
        : null;
    return { team: this.context, invitation };
  }

  public completeOwnerOnboardingPurchase(
    input: CreateTeamInput & { readonly onboardingId: string }
  ): Promise<TeamCreationResult> {
    void input.onboardingId;
    return this.storeTeam(input);
  }

  public async ensureInitialTeam(
    input: CreateTeamInput
  ): Promise<TeamContextRecord> {
    const existing = await this.findCurrentTeam(input.ownerUserId);
    if (existing) {
      return existing;
    }
    if (this.members.some(({ userId }) => userId === input.ownerUserId)) {
      throw new AppError(
        "INITIAL_TEAM_NOT_AVAILABLE",
        "membership is not active",
        409
      );
    }
    return (await this.createTeam(input)).team;
  }

  public async findCurrentTeam(
    userId: string
  ): Promise<TeamContextRecord | null> {
    const member = this.members.find(
      (candidate) => candidate.userId === userId
    );
    if (!this.context || !member) {
      return null;
    }
    return {
      ...this.context,
      role: member.role,
      membershipId: member.membershipId
    };
  }

  public async findTeamForUser(
    userId: string,
    teamId: string
  ): Promise<TeamContextRecord | null> {
    if (this.context?.teamId !== teamId) {
      return null;
    }
    return this.findCurrentTeam(userId);
  }

  public async listActiveMembers(): Promise<readonly TeamMemberRecord[]> {
    return this.members;
  }

  public async updateContractSettings(input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly seatLimit: number;
    readonly keywords: readonly string[];
    readonly currentTermAmountYen: number;
  }): Promise<TeamContextRecord> {
    if (!this.context || this.context.teamId !== input.teamId) {
      throw new AppError("TEAM_NOT_FOUND", "missing", 404);
    }
    const requester = this.members.find(
      ({ userId }) => userId === input.actorUserId
    );
    if (requester?.role !== "OWNER") {
      throw new AppError("OWNER_REQUIRED", "owner only", 403);
    }
    const activeMemberCount = this.members.filter(
      ({ role }) => role === "MEMBER"
    ).length;
    if (input.seatLimit < activeMemberCount) {
      throw new AppError("SEAT_LIMIT_BELOW_OCCUPANCY", "occupied", 409);
    }
    this.context = {
      ...this.context,
      keywords: [...input.keywords],
      currentTermAmountYen: input.currentTermAmountYen,
      renewalAmountYen: input.currentTermAmountYen,
      seatSummary: calculateSeatSummary(input.seatLimit, activeMemberCount)
    };
    return this.context;
  }

  public async createContractChangeQuote(input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly seatLimit: number;
    readonly keywords: readonly string[];
    readonly connectionKeywords: readonly ContractConnectionSettings[];
    readonly idempotencyKey: string;
    readonly expiresAt: Date;
  }): Promise<ContractChangeQuoteRecord> {
    if (!this.context || this.context.teamId !== input.teamId) {
      throw new AppError("TEAM_NOT_FOUND", "missing", 404);
    }
    const requester = this.members.find(
      ({ userId }) => userId === input.actorUserId
    );
    if (requester?.role !== "OWNER") {
      throw new AppError("OWNER_REQUIRED", "owner only", 403);
    }
    const repeated = this.contractQuotes.find(
      ({ idempotencyKey }) => idempotencyKey === input.idempotencyKey
    );
    if (repeated) return repeated;
    const activeMemberCount = this.members.filter(
      ({ role }) => role === "MEMBER"
    ).length;
    if (input.seatLimit < activeMemberCount) {
      throw new AppError("SEAT_LIMIT_BELOW_OCCUPANCY", "occupied", 409);
    }
    if (
      this.context.seatSummary.seatLimit === input.seatLimit &&
      JSON.stringify(this.context.keywords) === JSON.stringify(input.keywords)
    ) {
      throw new AppError(
        "CONTRACT_SETTINGS_UNCHANGED",
        "変更内容がありません。",
        409
      );
    }
    const nextAnnualAmountYen =
      6_000 +
      input.seatLimit * 100 +
      Math.max(input.keywords.length - 3, 0) * 100;
    const quote: StoredContractQuote = {
      id: randomUUID(),
      status: "PENDING",
      teamId: input.teamId,
      actorUserId: input.actorUserId,
      seatLimit: input.seatLimit,
      keywords: [...input.keywords],
      connectionKeywords: input.connectionKeywords.map((connection) => ({
        connectionId: connection.connectionId,
        keywords: [...connection.keywords]
      })),
      idempotencyKey: input.idempotencyKey,
      applyIdempotencyKey: null,
      previousAnnualAmountYen: this.context.currentTermAmountYen,
      nextAnnualAmountYen,
      additionalChargeYen: Math.max(
        nextAnnualAmountYen - this.context.currentTermAmountYen,
        0
      ),
      seatCount: input.seatLimit + 1,
      keywordCount: input.keywords.length,
      mailConnectionCount: input.connectionKeywords.length,
      expiresAt: input.expiresAt
    };
    this.contractQuotes.push(quote);
    return quote;
  }

  public async applyContractChangeQuote(input: {
    readonly teamId: string;
    readonly quoteId: string;
    readonly actorUserId: string;
    readonly applyIdempotencyKey: string;
    readonly expectedPreviousAnnualAmountYen: number;
    readonly expectedNextAnnualAmountYen: number;
    readonly expectedAdditionalChargeYen: number;
    readonly now: Date;
  }): Promise<AppliedContractChangeRecord> {
    const quote = this.contractQuotes.find(({ id }) => id === input.quoteId);
    if (
      !quote ||
      quote.teamId !== input.teamId ||
      quote.actorUserId !== input.actorUserId
    ) {
      throw new AppError("CONTRACT_CHANGE_QUOTE_NOT_FOUND", "missing", 404);
    }
    const context = this.context;
    if (!context) {
      throw new AppError("TEAM_NOT_FOUND", "missing", 404);
    }
    if (quote.status === "APPLIED") {
      if (quote.applyIdempotencyKey !== input.applyIdempotencyKey) {
        throw new AppError("CONTRACT_CHANGE_ALREADY_APPLIED", "applied", 409);
      }
      return { quote, team: context };
    }
    if (quote.expiresAt <= input.now) {
      throw new AppError("CONTRACT_CHANGE_QUOTE_EXPIRED", "expired", 409);
    }
    if (
      quote.previousAnnualAmountYen !== input.expectedPreviousAnnualAmountYen ||
      quote.nextAnnualAmountYen !== input.expectedNextAnnualAmountYen ||
      quote.additionalChargeYen !== input.expectedAdditionalChargeYen ||
      context.currentTermAmountYen !== quote.previousAnnualAmountYen
    ) {
      throw new AppError("CONTRACT_SETTINGS_CONFLICT", "stale", 409);
    }
    const currentTermAmountYen =
      quote.additionalChargeYen > 0
        ? quote.nextAnnualAmountYen
        : quote.previousAnnualAmountYen;
    this.context = {
      ...context,
      keywords: [...quote.keywords],
      currentTermAmountYen,
      renewalAmountYen: quote.nextAnnualAmountYen,
      seatSummary: calculateSeatSummary(
        quote.seatLimit,
        this.members.filter(({ role }) => role === "MEMBER").length
      )
    };
    const appliedQuote: StoredContractQuote = {
      ...quote,
      status: "APPLIED",
      applyIdempotencyKey: input.applyIdempotencyKey
    };
    this.contractQuotes.splice(
      this.contractQuotes.indexOf(quote),
      1,
      appliedQuote
    );
    return { quote: appliedQuote, team: this.context };
  }

  public async requestSeatLimitChange(input: {
    readonly teamId: string;
    readonly requestedByUserId: string;
    readonly requestedSeatLimit: number;
    readonly now: Date;
    readonly replacementInvitation: InvitationDraft | null;
  }): Promise<SeatLimitChangeResult> {
    if (!this.context || this.context.teamId !== input.teamId) {
      throw new AppError("TEAM_NOT_FOUND", "missing", 404);
    }
    const requester = this.members.find(
      ({ userId }) => userId === input.requestedByUserId
    );
    if (requester?.role !== "OWNER") {
      throw new AppError("OWNER_REQUIRED", "owner only", 403);
    }
    const previousSeatLimit = this.context.seatSummary.seatLimit;
    const activeMemberCount = this.members.filter(
      ({ role }) => role === "MEMBER"
    ).length;
    let status: SeatLimitChangeResult["status"];
    let appliedSeatLimit = previousSeatLimit;
    let invitation: IssuedInvitationRecord | null = null;

    if (input.requestedSeatLimit > previousSeatLimit) {
      status = "AWAITING_PAYMENT";
      this.context = { ...this.context, pendingSeatLimit: null };
    } else if (input.requestedSeatLimit >= activeMemberCount) {
      status = "APPLIED";
      appliedSeatLimit = input.requestedSeatLimit;
      const availableSeats = Math.max(appliedSeatLimit - activeMemberCount, 0);
      if (availableSeats > 0 && !input.replacementInvitation) {
        throw new Error("replacement_invitation_required");
      }
      this.context = {
        ...this.context,
        pendingSeatLimit: null,
        seatSummary: calculateSeatSummary(appliedSeatLimit, activeMemberCount)
      };
      if (availableSeats > 0 && input.replacementInvitation) {
        invitation = this.createInvitation(
          availableSeats,
          input.replacementInvitation
        );
      }
    } else {
      status = "PENDING_CAPACITY";
      this.context = {
        ...this.context,
        pendingSeatLimit: input.requestedSeatLimit
      };
    }

    const summary = calculateSeatSummary(appliedSeatLimit, activeMemberCount);
    const change: StoredChange = {
      teamId: input.teamId,
      changeId: randomUUID(),
      status,
      previousSeatLimit,
      requestedSeatLimit: input.requestedSeatLimit,
      activeMemberCount,
      availableSeats:
        status === "PENDING_CAPACITY" ? 0 : summary.availableSeats,
      invitation,
      paymentEventId: null
    };
    this.changes.push(change);
    return change;
  }

  public async applyPaidSeatIncrease(input: {
    readonly changeId: string;
    readonly paymentEventId: string;
    readonly now: Date;
    readonly invitation: InvitationDraft;
  }): Promise<SeatLimitChangeResult> {
    const change = this.changes.find(
      ({ changeId }) => changeId === input.changeId
    );
    if (!change || !this.context) {
      throw new AppError("SEAT_INCREASE_NOT_PAYABLE", "missing", 409);
    }
    if (change.status === "APPLIED") {
      if (change.paymentEventId !== input.paymentEventId) {
        throw new AppError("PAYMENT_EVENT_CONFLICT", "conflict", 409);
      }
      return change;
    }
    if (change.status !== "AWAITING_PAYMENT") {
      throw new AppError("SEAT_INCREASE_NOT_PAYABLE", "missing", 409);
    }
    if (
      this.changes.some(
        (candidate) =>
          candidate.changeId !== change.changeId &&
          candidate.paymentEventId === input.paymentEventId
      )
    ) {
      throw new AppError("PAYMENT_EVENT_CONFLICT", "conflict", 409);
    }
    const activeMemberCount = this.members.filter(
      ({ role }) => role === "MEMBER"
    ).length;
    const summary = calculateSeatSummary(
      change.requestedSeatLimit,
      activeMemberCount
    );
    change.status = "APPLIED";
    change.availableSeats = summary.availableSeats;
    change.paymentEventId = input.paymentEventId;
    change.invitation = this.createInvitation(
      summary.availableSeats,
      input.invitation
    );
    this.context = {
      ...this.context,
      pendingSeatLimit: null,
      seatSummary: summary
    };
    return change;
  }

  public addMember(userId: string = randomUUID()): void {
    if (!this.context) {
      throw new Error("Create a team first");
    }
    this.members.push({
      membershipId: randomUUID(),
      userId,
      email: `${userId}@example.com`,
      displayName: null,
      role: "MEMBER",
      joinedAt: new Date()
    });
    this.context = {
      ...this.context,
      seatSummary: calculateSeatSummary(
        this.context.seatSummary.seatLimit,
        this.members.filter(({ role }) => role === "MEMBER").length
      )
    };
  }

  private createInvitation(
    maxUses: number,
    draft: InvitationDraft
  ): IssuedInvitationRecord {
    const invitation = {
      id: randomUUID(),
      maxUses,
      usedCount: 0,
      expiresAt: draft.expiresAt,
      createdAt: new Date()
    };
    this.invitations.push(invitation);
    return invitation;
  }
}
