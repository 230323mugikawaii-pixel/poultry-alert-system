import { AppError } from "../../lib/app-error.js";

export const KEYWORD_MAX_LENGTH = 100;

export function normalizeTeamKeywords(values: readonly string[]): string[] {
  if (values.length === 0) {
    return [];
  }

  const keywords: string[] = [];
  const normalizedValues = new Set<string>();

  for (const value of values) {
    if (hasForbiddenKeywordCharacters(value)) {
      throw new AppError(
        "INVALID_KEYWORD_CHARACTERS",
        "キーワードには改行や制御文字を入力できません。",
        400
      );
    }

    const keyword = normalizeTeamKeyword(value);
    if (!keyword) {
      throw new AppError(
        "KEYWORD_REQUIRED",
        "キーワードを入力してください。",
        400
      );
    }

    if (Array.from(keyword).length > KEYWORD_MAX_LENGTH) {
      throw new AppError(
        "KEYWORD_TOO_LONG",
        `キーワードや短いフレーズは${KEYWORD_MAX_LENGTH}文字以内で入力してください。`,
        400
      );
    }

    const normalized = keyword.normalize("NFKC").toLocaleLowerCase("ja-JP");
    if (normalizedValues.has(normalized)) {
      throw new AppError(
        "DUPLICATE_KEYWORD",
        "同じキーワードが重複しています。",
        400
      );
    }

    normalizedValues.add(normalized);
    keywords.push(keyword);
  }

  return keywords;
}

export function normalizeTeamKeyword(value: string): string {
  return value.trim().replace(/[ \u00a0\u3000]+/gu, " ");
}

function hasForbiddenKeywordCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    );
  });
}
