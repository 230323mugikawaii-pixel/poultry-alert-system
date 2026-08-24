import { describe, expect, it } from "vitest";
import {
  calculateAnnualPriceYen,
  calculateSeatSummary,
  canAddMember
} from "../src/modules/teams/seat-policy.js";

describe("additional member seat policy", () => {
  it("never includes the owner in seatLimit or activeMemberCount", () => {
    expect(calculateSeatSummary(5, 4)).toEqual({
      seatLimit: 5,
      activeMemberCount: 4,
      availableSeats: 1,
      totalUserLimit: 6,
      currentUserCount: 5
    });
    expect(canAddMember(5, 4)).toBe(true);
    expect(canAddMember(5, 5)).toBe(false);
  });

  it.each([
    { seatLimit: 0, keywords: 3, expected: 6000 },
    { seatLimit: 5, keywords: 3, expected: 6500 },
    { seatLimit: 5, keywords: 4, expected: 6600 }
  ])(
    "calculates the annual price for $seatLimit seats and $keywords keywords",
    (testCase) => {
      expect(
        calculateAnnualPriceYen(testCase.seatLimit, testCase.keywords)
      ).toBe(testCase.expected);
    }
  );
});
