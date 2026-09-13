import { normalizeTeamKeywordForComparison } from "../../teams/keyword-policy.js";
import type { GmailMatchContent } from "./gmail-message-content.js";

export function findFirstMatchingKeyword(
  keywords: readonly string[],
  content: GmailMatchContent
): string | null {
  const searchableText = normalizeMessageText(
    `${content.subject}\n${content.body}`
  );
  for (const keyword of keywords) {
    const normalizedKeyword = normalizeTeamKeywordForComparison(keyword);
    if (normalizedKeyword && searchableText.includes(normalizedKeyword)) {
      return keyword;
    }
  }
  return null;
}

function normalizeMessageText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ja-JP")
    .replace(/[\s\u00a0\u3000]+/gu, " ")
    .trim();
}
