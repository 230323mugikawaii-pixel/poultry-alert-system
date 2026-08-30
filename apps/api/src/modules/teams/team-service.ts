import { randomInt } from "node:crypto";
import { AppError } from "../../lib/app-error.js";
import type {
  InvitationDraft,
  SeatLimitChangeResult,
  TeamCreationResult,
  TeamContextRecord,
  TeamMemberRecord,
  TeamRepository
} from "./team-repository.js";
import {
  assertConfiguredSeatCount,
  calculateAnnualPriceYen,
  calculateSeatSummary,
  DEFAULT_MAX_CONFIGURED_SEAT_COUNT
} from "./seat-policy.js";
import { normalizeTeamKeywords } from "./keyword-policy.js";

export interface TeamServiceOptions {
  readonly repository: TeamRepository;
  readonly now?: () => Date;
  readonly teamCodeGenerator?: () => string;
  readonly maxConfiguredSeatCount?: number;
}

export class TeamService {
  private readonly now: () => Date;
  private readonly teamCodeGenerator: () => string;
  private readonly maxConfiguredSeatCount: number;

  public constructor(private readonly options: TeamServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.teamCodeGenerator = options.teamCodeGenerator ?? generateTeamCode;
    this.maxConfiguredSeatCount =
      options.maxConfiguredSeatCount ?? DEFAULT_MAX_CONFIGURED_SEAT_COUNT;
  }

  public async createTeam(
    input: {
      readonly ownerUserId: string;
      readonly name?: string;
      readonly seatLimit: number;
      readonly keywords?: readonly string[];
    },
    initialInvitation: InvitationDraft | null = null
  ): Promise<TeamCreationResult> {
    assertConfiguredSeatCount(input.seatLimit + 1, this.maxConfiguredSeatCount);
    calculateSeatSummary(input.seatLimit, 0);
    if (input.seatLimit > 0 && !initialInvitation) {
      throw new AppError(
        "INITIAL_INVITATION_REQUIRED",
        "追加メンバー枠には初回招待情報が必要です。",
        500
      );
    }
    const keywords = normalizeTeamKeywords(input.keywords ?? []);
    const now = this.now();
    const termEnd = new Date(now);
    termEnd.setUTCFullYear(termEnd.getUTCFullYear() + 1);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        return await this.options.repository.createTeam({
          ownerUserId: input.ownerUserId,
          publicCode: this.teamCodeGenerator(),
          name: input.name?.trim().slice(0, 120) || null,
          seatLimit: input.seatLimit,
          keywords,
          currentTermStartedAt: now,
          currentTermEndsAt: termEnd,
          currentTermAmountYen: calculateAnnualPriceYen(
            input.seatLimit,
            keywords.length
          ),
          initialInvitation
        });
      } catch (error) {
        if (!isTeamCodeConflict(error)) {
          throw error;
        }
      }
    }

    throw new AppError(
      "TEAM_CODE_GENERATION_FAILED",
      "チームIDを発行できませんでした。もう一度お試しください。",
      503
    );
  }

  public async ensureInitialTeamForUser(input: {
    readonly userId: string;
    readonly keywords?: readonly string[];
  }): Promise<TeamContextRecord> {
    const keywords = normalizeTeamKeywords(input.keywords ?? []);
    const now = this.now();
    const termEnd = new Date(now);
    termEnd.setUTCFullYear(termEnd.getUTCFullYear() + 1);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        return await this.options.repository.ensureInitialTeam({
          ownerUserId: input.userId,
          publicCode: this.teamCodeGenerator(),
          name: null,
          seatLimit: 0,
          keywords,
          currentTermStartedAt: now,
          currentTermEndsAt: termEnd,
          currentTermAmountYen: calculateAnnualPriceYen(0, keywords.length),
          initialInvitation: null
        });
      } catch (error) {
        if (!isTeamCodeConflict(error)) {
          throw error;
        }
      }
    }

    throw new AppError(
      "TEAM_CODE_GENERATION_FAILED",
      "初期設定を完了できませんでした。もう一度お試しください。",
      503
    );
  }

  public async completeOwnerOnboardingPurchase(input: {
    readonly userId: string;
    readonly onboardingId: string;
    readonly keywords: readonly string[];
    readonly seatCount: number;
  }): Promise<TeamCreationResult> {
    assertConfiguredSeatCount(input.seatCount, this.maxConfiguredSeatCount);
    const seatLimit = input.seatCount - 1;
    calculateSeatSummary(seatLimit, 0);
    const keywords = normalizeTeamKeywords(input.keywords);
    const now = this.now();
    const termEnd = new Date(now);
    termEnd.setUTCFullYear(termEnd.getUTCFullYear() + 1);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        return await this.options.repository.completeOwnerOnboardingPurchase({
          onboardingId: input.onboardingId,
          ownerUserId: input.userId,
          publicCode: this.teamCodeGenerator(),
          name: null,
          seatLimit,
          keywords,
          currentTermStartedAt: now,
          currentTermEndsAt: termEnd,
          currentTermAmountYen: calculateAnnualPriceYen(
            seatLimit,
            keywords.length
          ),
          initialInvitation: null
        });
      } catch (error) {
        if (!isTeamCodeConflict(error)) throw error;
      }
    }
    throw new AppError(
      "TEAM_CODE_GENERATION_FAILED",
      "初期設定を完了できませんでした。もう一度お試しください。",
      503
    );
  }

  public async getCurrentTeam(userId: string): Promise<TeamContextRecord> {
    const context = await this.options.repository.findCurrentTeam(userId);
    if (!context) {
      throw new AppError("TEAM_NOT_FOUND", "所属チームが見つかりません。", 404);
    }
    return context;
  }

  public async listMembers(
    userId: string
  ): Promise<readonly TeamMemberRecord[]> {
    const context = await this.requireOwner(userId);
    return this.options.repository.listActiveMembers(context.teamId);
  }

  public async requestSeatLimitChange(
    userId: string,
    requestedSeatLimit: number,
    replacementInvitation: InvitationDraft | null = null
  ): Promise<SeatLimitChangeResult> {
    assertConfiguredSeatCount(
      requestedSeatLimit + 1,
      this.maxConfiguredSeatCount
    );
    calculateSeatSummary(requestedSeatLimit, 0);
    const context = await this.requireOwner(userId);
    return this.options.repository.requestSeatLimitChange({
      teamId: context.teamId,
      requestedByUserId: userId,
      requestedSeatLimit,
      now: this.now(),
      replacementInvitation
    });
  }

  public async requireOwner(userId: string): Promise<TeamContextRecord> {
    const context = await this.getCurrentTeam(userId);
    if (context.role !== "OWNER") {
      throw new AppError(
        "OWNER_REQUIRED",
        "この操作はチームの代表者だけが実行できます。",
        403
      );
    }
    return context;
  }

  public async requireOwnerForTeam(
    userId: string,
    teamId: string
  ): Promise<TeamContextRecord> {
    const context = await this.options.repository.findTeamForUser(
      userId,
      teamId
    );
    if (!context) {
      throw new AppError("TEAM_NOT_FOUND", "所属チームが見つかりません。", 404);
    }
    if (context.role !== "OWNER") {
      throw new AppError(
        "OWNER_REQUIRED",
        "この操作はチームの代表者だけが実行できます。",
        403
      );
    }
    return context;
  }
}

export function generateTeamCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function isTeamCodeConflict(error: unknown): boolean {
  return error instanceof AppError && error.code === "TEAM_CODE_CONFLICT";
}
