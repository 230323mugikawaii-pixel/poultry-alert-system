import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(
  new URL("../js/app.js", import.meta.url),
  "utf8",
);
const htmlSource = readFileSync(
  new URL("../index.html", import.meta.url),
  "utf8",
);

test("owner navigation separates details from contract settings", () => {
  assert.match(htmlSource, /<small>詳細<\/small>/);
  assert.match(htmlSource, /<small>契約内容<\/small>/);
  assert.match(htmlSource, /id="contractPage"[\s\S]*?<h1>\s*詳細\s*<\/h1>/);
  assert.match(htmlSource, /id="keywordPage"[\s\S]*?<h1>\s*契約内容\s*<\/h1>/);
  assert.doesNotMatch(
    htmlSource.match(/id="contractPage"[\s\S]*?<\/section>/)?.[0] ?? "",
    /キーワード数/,
  );
});

test("contract settings use server team and provider keyword data", () => {
  assert.match(appSource, /hydrateContractKeywordsFromServer/);
  assert.match(appSource, /currentTeam\.keywords/);
  assert.match(appSource, /connection\.keywords/);
  assert.match(appSource, /\/contract-settings/);
  assert.match(appSource, /method: "PUT"/);
  assert.match(appSource, /現在の年額/);
  assert.match(htmlSource, /id="contractCurrentAnnualPrice"/);
  assert.match(htmlSource, /id="contractNextAnnualPrice"/);
  assert.match(htmlSource, /id="contractSeatCount"/);
});

test("test cards are dynamic and explain the true zero-keyword state", () => {
  assert.match(appSource, /keywords\.forEach\(\(keyword\) =>/);
  assert.match(appSource, /通知キーワードが設定されていません。/);
  assert.match(appSource, /契約内容を設定する/);
  assert.doesNotMatch(
    htmlSource.match(/id="testKeywordCards"[\s\S]*?<\/div>/)?.[0] ?? "",
    /停電|通電|警報/,
  );
});

test("contract pricing deduplicates cross-provider keywords and counts total seats", () => {
  assert.match(appSource, /mergeContractBillingKeywords/);
  assert.match(appSource, /normalize\("NFKC"\)/);
  assert.match(appSource, /settings\.seatCount - 1/);
  assert.match(appSource, /実際の決済は行われません/);
});
