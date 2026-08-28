import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

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
  assert.match(
    appSource,
    /\/api\/v1\/owner-onboarding\/choices\/\$\{encodeURIComponent\(choiceId\)\}\/\$\{action\}/
  );
  assert.doesNotMatch(
    appSource.match(
      /function startOwnerMonitoringOAuth[\s\S]*?\n}/
    )?.[0] ?? "",
    /localStorage|sessionStorage|accessToken|refreshToken/
  );
});

test("setup exposes the compact three-step flow and explicit final actions", () => {
  assert.match(
    htmlSource,
    /1 監視アカウント[\s\S]*2 利用設定[\s\S]*3 購入/
  );
  assert.match(appSource, /このアカウントを監視する/);
  assert.match(appSource, /あとで変更/);
  assert.match(appSource, /このGmailアカウントを監視しますか/);
  assert.match(appSource, /このMicrosoft 365アカウントを監視しますか/);
});

test("both skipped providers are rejected inline and demo purchase is explicit", () => {
  assert.match(
    appSource,
    /少なくとも1つの監視アカウントを設定してください/
  );
  assert.match(htmlSource, /現在は試作版です/);
  assert.match(htmlSource, /実際の料金は発生しません/);
});

test("owner pricing counts each input as one keyword and additional users separately", () => {
  assert.match(appSource, /const EXTRA_USER_PRICE = 100/);
  assert.match(appSource, /Math\.max\(ownerSetupSeatCount - 1, 0\)/);
  assert.match(appSource, /keywordPolicy\.calculateAnnualPriceYen/);
  assert.match(htmlSource, /管理者1人を含む合計利用人数/);
});
