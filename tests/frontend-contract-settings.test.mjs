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
  assert.match(appSource, /\/contract-settings\/quote/);
  assert.match(appSource, /\/contract-settings\/quotes\/\$\{encodeURIComponent\(quote\.id\)\}\/apply/);
  assert.match(appSource, /method: "POST"/);
  assert.match(appSource, /現在の年額/);
  assert.match(htmlSource, /id="contractCurrentAnnualPrice"/);
  assert.match(htmlSource, /id="contractNextAnnualPrice"/);
  assert.match(htmlSource, /id="contractSeatCount"/);
});

test("price increases use a server quote and a dedicated difference checkout", () => {
  assert.match(htmlSource, /id="contractChangeCheckoutScreen"/);
  assert.match(htmlSource, /契約変更の決済内容を確認/);
  assert.match(htmlSource, /今回の追加料金/);
  assert.match(htmlSource, /追加料金を確定して変更を適用/);
  assert.match(appSource, /quote\.additionalChargeYen > 0/);
  assert.match(appSource, /openContractChangeCheckout/);
  assert.match(appSource, /expectedPreviousAnnualAmountYen/);
  assert.match(appSource, /expectedNextAnnualAmountYen/);
  assert.match(appSource, /expectedAdditionalChargeYen/);
  assert.match(appSource, /変更を適用中…/);
  assert.match(appSource, /契約情報が更新されました。内容と料金をもう一度確認してください。/);
});

test("same-price and downgrade changes bypass checkout with clear explanations", () => {
  assert.match(appSource, /追加料金はありません。契約内容を保存しますか？/);
  assert.match(appSource, /現在の契約期間中の返金はありません。/);
  assert.match(appSource, /次回更新時から年額/);
  assert.match(appSource, /変更内容がありません。/);
});

test("contract validation is inline, focusable, and clears on correction", () => {
  assert.match(htmlSource, /id="contractSettingsError"[\s\S]*?role="alert"/);
  assert.match(htmlSource, /id="contractSeatError"/);
  assert.match(appSource, /aria-invalid/);
  assert.match(appSource, /scrollIntoView/);
  assert.match(appSource, /focus\?\./);
  assert.match(appSource, /監視アカウントを1件以上設定してください。/);
  assert.match(appSource, /各監視アカウントに通知キーワードを1件以上設定してください。/);
  assert.match(appSource, /合計利用人数は1以上の整数で入力してください。/);
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
