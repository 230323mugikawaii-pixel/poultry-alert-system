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
    { seatCount: 1, keywords: 3, expected: 6000 },
    { seatCount: 2, keywords: 3, expected: 6100 },
    { seatCount: 10, keywords: 3, expected: 6900 },
    { seatCount: 11, keywords: 3, expected: 7000 },
    { seatCount: 25, keywords: 3, expected: 8400 },
    { seatCount: 100, keywords: 3, expected: 15900 },
    { seatCount: 6, keywords: 4, expected: 6600 }
  ])(
    "calculates the annual price for $seatCount people and $keywords keywords",
    (testCase) => {
      expect(
        calculateAnnualPriceYen(testCase.seatCount - 1, testCase.keywords)
      ).toBe(testCase.expected);
      expect(calculateSeatSummary(testCase.seatCount - 1, 0)).toMatchObject({
        totalUserLimit: testCase.seatCount
      });
    }
  );
});
