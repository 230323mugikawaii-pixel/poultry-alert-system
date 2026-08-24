import { describe, expect, it } from "vitest";
import {
  normalizeTeamKeyword,
  normalizeTeamKeywords
} from "../src/modules/teams/keyword-policy.js";

describe("team keyword policy", () => {
  it.each([
    "博衣こより",
    "山田太郎",
    "山田 太郎",
    "東京 電力",
    "Call Now",
    "システム障害",
    "停電のお知らせ",
    "火災",
    "爆発",
    "殺害予告",
    "脅迫",
    "自殺",
    "不審者",
    "Ｔｅｓｔ１２３"
  ])("accepts %s as one keyword", (keyword) => {
    expect(normalizeTeamKeywords([keyword])).toEqual([keyword]);
  });

  it("normalizes surrounding and repeated horizontal spaces", () => {
    expect(normalizeTeamKeyword("  山田　   太郎  ")).toBe("山田 太郎");
  });

  it.each([
    ["", "KEYWORD_REQUIRED"],
    ["　 ", "KEYWORD_REQUIRED"],
    ["停電\nのお知らせ", "INVALID_KEYWORD_CHARACTERS"],
    ["停電\t警報", "INVALID_KEYWORD_CHARACTERS"],
    ["あ".repeat(101), "KEYWORD_TOO_LONG"]
  ])("rejects invalid keyword input", (keyword, code) => {
    expect(() => normalizeTeamKeywords([keyword])).toThrowError(
      expect.objectContaining({ code })
    );
  });

  it("rejects normalized duplicates", () => {
    expect(() =>
      normalizeTeamKeywords(["Call Now", "ＣＡＬＬ　ＮＯＷ"])
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_KEYWORD" }));
  });

  it("accepts exactly 100 characters", () => {
    const keyword = "あ".repeat(100);
    expect(normalizeTeamKeywords([keyword])).toEqual([keyword]);
  });
});
