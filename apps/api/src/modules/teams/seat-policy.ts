import { AppError } from "../../lib/app-error.js";

export const BASE_ANNUAL_PRICE_YEN = 6_000;
export const ADDITIONAL_MEMBER_ANNUAL_PRICE_YEN = 100;
export const INCLUDED_KEYWORD_COUNT = 3;
export const EXTRA_KEYWORD_ANNUAL_PRICE_YEN = 100;

export interface SeatSummary {
  readonly seatLimit: number;
  readonly activeMemberCount: number;
  readonly availableSeats: number;
  readonly totalUserLimit: number;
  readonly currentUserCount: number;
}

export function calculateSeatSummary(
  seatLimit: number,
  activeMemberCount: number
): SeatSummary {
  assertNonNegativeInteger(seatLimit, "seatLimit");
  assertNonNegativeInteger(activeMemberCount, "activeMemberCount");

  return {
    seatLimit,
    activeMemberCount,
    availableSeats: Math.max(seatLimit - activeMemberCount, 0),
    totalUserLimit: 1 + seatLimit,
    currentUserCount: 1 + activeMemberCount
  };
}

export function canAddMember(
  seatLimit: number,
  activeMemberCount: number
): boolean {
  return calculateSeatSummary(seatLimit, activeMemberCount).availableSeats > 0;
}

export function calculateAnnualPriceYen(
  seatLimit: number,
  keywordCount: number
): number {
  assertNonNegativeInteger(seatLimit, "seatLimit");
  assertNonNegativeInteger(keywordCount, "keywordCount");

  return (
    BASE_ANNUAL_PRICE_YEN +
    seatLimit * ADDITIONAL_MEMBER_ANNUAL_PRICE_YEN +
    Math.max(keywordCount - INCLUDED_KEYWORD_COUNT, 0) *
      EXTRA_KEYWORD_ANNUAL_PRICE_YEN
  );
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new AppError(
      "INVALID_SEAT_CONFIGURATION",
      `${field} must be a non-negative integer.`,
      400
    );
  }
}
