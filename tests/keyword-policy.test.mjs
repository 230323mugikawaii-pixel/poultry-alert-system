import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const keywordPolicy = require("../js/keyword-policy.js");

const allowedKeywords = [
  "停電",
  "通電",
  "警報",
  "博衣こより",
  "山田太郎",
  "山田 太郎",
  "東京電力",
  "東京 電力",
  "システム障害",
  "停電のお知らせ",
  "契約更新",
  "Call Now",
  "火災",
  "爆発",
  "殺害予告",
  "脅迫",
  "自殺",
  "不審者",
  "災害2026",
  "Ｔｅｓｔ１２３",
  "製品-A/B"
];

test("allows names and short monitoring phrases as one keyword", () => {
  for (const keyword of allowedKeywords) {
    const result =
      keywordPolicy.validateKeywordList([
        keyword
      ]);

    assert.equal(
      result.valid,
      true,
      keyword
    );
    assert.deepEqual(
      result.keywords,
      [keyword]
    );
  }
});

test("trims surrounding space and collapses repeated horizontal space", () => {
  assert.equal(
    keywordPolicy.normalizeKeyword(
      "  山田　   太郎  "
    ),
    "山田 太郎"
  );
});

test("rejects blank, line breaks, control characters, and overlong text", () => {
  const cases = [
    ["", "EMPTY_KEYWORD"],
    ["  　", "EMPTY_KEYWORD"],
    [
      "停電\nのお知らせ",
      "FORBIDDEN_CHARACTERS"
    ],
    [
      "停電\t警報",
      "FORBIDDEN_CHARACTERS"
    ],
    [
      "あ".repeat(101),
      "KEYWORD_TOO_LONG"
    ]
  ];

  for (const [value, reasonCode] of cases) {
    assert.equal(
      keywordPolicy.validateKeyword(
        value
      ).reasonCode,
      reasonCode
    );
  }

  assert.equal(
    keywordPolicy.validateKeywordList([
      "停電",
      ""
    ]).reasonCode,
    "EMPTY_KEYWORD"
  );
  assert.equal(
    keywordPolicy.validateKeyword(
      "あ".repeat(100)
    ).valid,
    true
  );
});

test("rejects duplicates after space, width, and case normalization", () => {
  const result =
    keywordPolicy.validateKeywordList([
      "Call Now",
      "ＣＡＬＬ　ＮＯＷ"
    ]);

  assert.equal(result.valid, false);
  assert.equal(
    result.reasonCode,
    "DUPLICATE_KEYWORD"
  );
});

test("counts each field as one keyword for pricing", () => {
  const phrases = [
    "停電",
    "博衣こより",
    "山田 太郎",
    "Call Now"
  ];
  const result =
    keywordPolicy.validateKeywordList(
      phrases
    );

  assert.equal(result.valid, true);
  assert.equal(
    result.keywords.length,
    4
  );
  assert.equal(
    keywordPolicy.calculateAnnualPriceYen(
      result.keywords.length
    ),
    6100
  );
});

test("preserves short phrases in the notification JSON body", () => {
  for (const keyword of [
    "博衣こより",
    "山田 太郎",
    "停電のお知らせ",
    "Call Now"
  ]) {
    const serialized = JSON.stringify({
      keyword
    });

    assert.equal(
      JSON.parse(serialized).keyword,
      keyword
    );
  }
});

test("quotes Gmail search phrases without allowing query injection", () => {
  assert.equal(
    keywordPolicy.quoteGmailSearchPhrase(
      'Call "Now" \\ test'
    ),
    '"Call \\"Now\\" \\\\ test"'
  );
  assert.throws(() =>
    keywordPolicy.quoteGmailSearchPhrase(
      "Call Now\nfrom:anyone"
    )
  );
});
