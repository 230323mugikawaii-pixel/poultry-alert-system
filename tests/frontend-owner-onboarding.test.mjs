import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const ownerOnboardingRouting = require(
  "../js/owner-onboarding-routing.js"
);

const appSource = readFileSync(
  new URL("../js/app.js", import.meta.url),
  "utf8"
);
const htmlSource = readFileSync(
  new URL("../index.html", import.meta.url),
  "utf8"
);

test("guest owners enter monitoring setup without a separate primary-login screen", () => {
  assert.match(
    htmlSource,
    /onclick="openOwnerSetup\(\)"[\s\S]*Call Nowを設定する/
  );
  assert.match(htmlSource, /id="ownerMonitoringSetupScreen"/);
  assert.match(htmlSource, /Googleを設定する/);
  assert.match(htmlSource, /Microsoftを設定する/);
  assert.match(htmlSource, /今回は設定しない/g);
  assert.doesNotMatch(
    htmlSource.match(
      /id="ownerMonitoringSetupScreen"[\s\S]*?<\/section>/
    )?.[0] ?? "",
    /本人確認|Primary Login|Authorization/
  );
});

test("owner setup uses one provider OAuth ceremony and server-side onboarding state", () => {
  assert.match(
    appSource,
    /\/api\/v1\/owner-onboarding\/oauth\/\$\{provider\.toLowerCase\(\)\}\/start/
  );
  assert.match(appSource, /\/api\/v1\/owner-onboarding\/current/);
  assert.match(appSource, /\/api\/v1\/owner-onboarding\/demo-purchase/);
  assert.doesNotMatch(
    appSource.match(
      /function startOwnerMonitoringOAuth[\s\S]*?\n}/
    )?.[0] ?? "",
    /localStorage|sessionStorage|accessToken|refreshToken/
  );
});

test("setup exposes the compact three-step flow without a post-purchase confirmation", () => {
  assert.match(
    htmlSource,
    /1 監視アカウント[\s\S]*2 利用設定[\s\S]*3 購入/
  );
  assert.doesNotMatch(htmlSource, /監視アカウント確認/);
  assert.doesNotMatch(appSource, /openMonitoringConfirmation/);
  assert.match(htmlSource, /type="number"[\s\S]*min="1"/);
  assert.doesNotMatch(htmlSource, /id="ownerSeatCount"[\s\S]*max="10"/);
});

test("OAuth returns to provider setup and configured cards show an unambiguous state", () => {
  assert.match(
    appSource,
    /ownerOnboarding\?\.status\s*===\s*"PENDING"[\s\S]*openOwnerSetup\(\)/
  );
  assert.match(appSource, /✓ 設定しました/);
  assert.match(appSource, /Googleアカウントを変更/);
  assert.match(appSource, /Microsoftアカウントを変更/);
});

test("server-side onboarding state takes priority over an existing team", () => {
  const select = ownerOnboardingRouting.selectAuthenticatedDestination;

  assert.ok(
    (appSource.match(/openAuthenticatedStartupDestination\(\)/gu) ?? [])
      .length >= 4,
    "callback and query-free startup paths use the shared routing decision"
  );

  assert.equal(
    select({ onboardingStatus: "PENDING", hasCurrentTeam: false }),
    "OWNER_SETUP",
    "A: a new owner with pending onboarding continues setup"
  );
  assert.equal(
    select({ onboardingStatus: "PENDING", hasCurrentTeam: true }),
    "OWNER_SETUP",
    "B: pending onboarding takes priority over an existing team"
  );
  assert.equal(
    select({ onboardingStatus: null, hasCurrentTeam: true }),
    "APP",
    "C: an existing team without onboarding opens Home"
  );
  assert.equal(
    select({ onboardingStatus: "PURCHASED", hasCurrentTeam: true }),
    "APP",
    "D: a legacy purchased onboarding resumes the app while the server settles monitoring"
  );
  assert.equal(
    select({ onboardingStatus: "PENDING", hasCurrentTeam: true }),
    "OWNER_SETUP",
    "E: server-side pending state works without a callback query parameter"
  );
  assert.equal(
    select({ onboardingStatus: "EXPIRED", hasCurrentTeam: true }),
    "APP",
    "F: an expired onboarding does not interrupt an existing team"
  );
  for (const status of ["COMPLETED", "ABANDONED", "CANCELLED"]) {
    assert.equal(
      select({ onboardingStatus: status, hasCurrentTeam: true }),
      "APP",
      `${status} onboarding does not interrupt an existing team`
    );
  }
});

test("provider keywords are decided separately and restored from the server", () => {
  assert.match(htmlSource, /id="ownerKeywordProviderTabs"/);
  assert.match(appSource, /choice\.keywordsConfirmedAt/);
  assert.match(appSource, /変更あり・再決定が必要/);
  assert.match(
    appSource,
    /\/api\/v1\/owner-onboarding\/choices\/\$\{encodeURIComponent\(currentChoice\.id\)\}\/keywords/
  );
  assert.match(appSource, /このアカウントのキーワードを決定/);
  assert.match(appSource, /Gmailの通知キーワード/);
  assert.match(appSource, /Microsoft 365の通知キーワード/);
  assert.match(appSource, /resetOwnerOnboardingClientState\(\)/);
});

test("Home does not render the large setup notice card", () => {
  assert.doesNotMatch(htmlSource, /id="homeSetupNoticeCard"/);
  assert.doesNotMatch(htmlSource, /はじめに設定してください/);
});

test("both skipped providers are rejected inline and demo purchase is explicit", () => {
  assert.match(
    appSource,
    /少なくとも1つの監視アカウントを設定してください/
  );
  assert.match(htmlSource, /現在は試作版です/);
  assert.match(htmlSource, /実際の料金は発生しません/);
});

test("an authorized provider enables usage setup and clears the missing-account warning", () => {
  assert.match(
    appSource,
    /function getOwnerAuthorizedChoices\(\)[\s\S]*?choice\.status === "AUTHORIZED"/
  );
  assert.match(
    appSource,
    /continueButton\.disabled\s*=\s*authorizedChoices\.length === 0/
  );
  assert.match(
    appSource,
    /authorizedChoices\.length === 0 &&[\s\S]*?skippedProviders\.length === 2/
  );
});

test("owner pricing counts each input as one keyword and additional users separately", () => {
  assert.match(appSource, /const EXTRA_USER_PRICE = 100/);
  assert.match(
    appSource,
    /Math\.max\(\s*ownerSetupSeatCount\s*-\s*1,\s*0\s*\)/
  );
  assert.match(appSource, /keywordPolicy\.calculateAnnualPriceYen/);
  assert.match(htmlSource, /管理者1人を含む合計利用人数/);
});
