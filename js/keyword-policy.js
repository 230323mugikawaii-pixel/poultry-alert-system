"use strict";

(function initializeKeywordPolicy(root, factory) {
  const policy = factory();

  if (
    typeof module === "object" &&
    module.exports
  ) {
    module.exports = policy;
  }

  if (root) {
    root.CallNowKeywordPolicy = policy;
  }
})(
  typeof globalThis !== "undefined"
    ? globalThis
    : this,
  () => {
    const KEYWORD_MAX_LENGTH = 100;
    const BASE_PRICE_YEN = 6000;
    const INCLUDED_KEYWORD_LIMIT = 3;
    const EXTRA_KEYWORD_PRICE_YEN = 100;

    function normalizeKeyword(value) {
      return String(value ?? "")
        .trim()
        .replace(
          /[ \u00a0\u3000]+/gu,
          " "
        );
    }

    function hasForbiddenCharacters(value) {
      return Array.from(
        String(value ?? "")
      ).some((character) => {
        const codePoint =
          character.codePointAt(0);

        return (
          codePoint <= 0x1f ||
          (
            codePoint >= 0x7f &&
            codePoint <= 0x9f
          ) ||
          codePoint === 0x2028 ||
          codePoint === 0x2029
        );
      });
    }

    function countCharacters(value) {
      return Array.from(
        String(value ?? "")
      ).length;
    }

    function comparisonKey(value) {
      return normalizeKeyword(value)
        .normalize("NFKC")
        .toLocaleLowerCase("ja-JP");
    }

    function quoteGmailSearchPhrase(value) {
      const phrase =
        String(value ?? "");

      if (
        hasForbiddenCharacters(
          phrase
        )
      ) {
        throw new TypeError(
          "Gmail検索フレーズに改行や制御文字は使用できません。"
        );
      }

      return (
        `"${phrase
          .replace(/\\/gu, "\\\\")
          .replace(/"/gu, '\\"')}"`
      );
    }

    function validateKeyword(value) {
      const rawValue =
        String(value ?? "");
      const keyword =
        normalizeKeyword(rawValue);

      if (!keyword) {
        return {
          valid: false,
          reasonCode: "EMPTY_KEYWORD",
          message:
            "空欄のキーワードがあります。不要な欄は削除してください。"
        };
      }

      if (
        hasForbiddenCharacters(
          rawValue
        )
      ) {
        return {
          valid: false,
          reasonCode:
            "FORBIDDEN_CHARACTERS",
          message:
            "キーワードには改行や制御文字を入力できません。"
        };
      }

      if (
        countCharacters(keyword) >
        KEYWORD_MAX_LENGTH
      ) {
        return {
          valid: false,
          reasonCode:
            "KEYWORD_TOO_LONG",
          message:
            `キーワードや短いフレーズは${KEYWORD_MAX_LENGTH}文字以内で入力してください。`
        };
      }

      return {
        valid: true,
        reasonCode: "VALID_KEYWORD",
        keyword
      };
    }

    function validateKeywordList(values) {
      if (
        !Array.isArray(values) ||
        values.length === 0
      ) {
        return {
          valid: false,
          reasonCode:
            "KEYWORD_REQUIRED",
          message:
            "最低1個のキーワードを入力してください。"
        };
      }

      const keywords = [];
      const comparisonKeys =
        new Set();

      for (
        let index = 0;
        index < values.length;
        index += 1
      ) {
        const result =
          validateKeyword(
            values[index]
          );

        if (!result.valid) {
          return {
            ...result,
            index
          };
        }

        const key = comparisonKey(
          result.keyword
        );

        if (
          comparisonKeys.has(key)
        ) {
          return {
            valid: false,
            reasonCode:
              "DUPLICATE_KEYWORD",
            message:
              "同じキーワードが重複しています。",
            index
          };
        }

        comparisonKeys.add(key);
        keywords.push(result.keyword);
      }

      return {
        valid: true,
        reasonCode:
          "VALID_KEYWORDS",
        keywords
      };
    }

    function calculateAnnualPriceYen(
      keywordCount
    ) {
      const count = Math.max(
        0,
        Number.isFinite(keywordCount)
          ? Math.floor(keywordCount)
          : 0
      );

      return (
        BASE_PRICE_YEN +
        Math.max(
          count -
            INCLUDED_KEYWORD_LIMIT,
          0
        ) *
          EXTRA_KEYWORD_PRICE_YEN
      );
    }

    return Object.freeze({
      KEYWORD_MAX_LENGTH,
      BASE_PRICE_YEN,
      INCLUDED_KEYWORD_LIMIT,
      EXTRA_KEYWORD_PRICE_YEN,
      normalizeKeyword,
      hasForbiddenCharacters,
      comparisonKey,
      quoteGmailSearchPhrase,
      validateKeyword,
      validateKeywordList,
      calculateAnnualPriceYen
    });
  }
);
