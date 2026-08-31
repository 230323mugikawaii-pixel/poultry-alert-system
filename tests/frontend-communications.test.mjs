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

test("Home keeps monitoring controls and the shared owner alert surface", () => {
  const home = htmlSource.match(
    /id="homePage"[\s\S]*?<\/section>/
  )?.[0];
  assert.ok(home, "Home should be present");
  assert.match(home, /監視アカウント/);
  assert.match(home, /重要通知/);
  assert.match(home, /id="ownerAlertList"/);
  assert.doesNotMatch(home, /サービス状況|お知らせ/);
  assert.doesNotMatch(home, />\s*未設定\s*</);

  assert.match(appSource, /refreshOwnerAlerts\(\)/);
  assert.match(appSource, /startOwnerAlertStream\(\)/);
  assert.match(appSource, /currentAlarmAlertContext/);
});

test("owner header uses a private notification center without normal logout UI", () => {
  const ownerApp = htmlSource.match(
    /id="appScreen"[\s\S]*?<main class="app-main">/
  )?.[0];
  assert.ok(ownerApp, "owner app header should be present");
  assert.match(ownerApp, /id="notificationCenterButton"/);
  assert.match(ownerApp, /id="notificationUnreadBadge"/);
  assert.doesNotMatch(ownerApp, /onclick="logout\(\)"/);

  assert.match(appSource, /\/api\/v1\/notifications/);
  assert.match(appSource, /\/read`/);
  assert.match(appSource, /notification\.readAt/);
  assert.match(htmlSource, /id="ownerEmergencyNotificationList"/);
  assert.match(htmlSource, />緊急通知</);
  assert.match(htmlSource, />お知らせ</);
  assert.match(appSource, /countUnreadAlerts\(ownerAlerts\)/);
  assert.match(appSource, /\/api\/v1\/auth\/logout/);
});

test("notification members have a private emergency notification bell", () => {
  assert.match(
    htmlSource,
    /id="notificationMemberNotificationCenterButton"/,
  );
  assert.match(htmlSource, /id="notificationMemberUnreadBadge"/);
  assert.match(
    htmlSource,
    /id="notificationMemberEmergencyNotificationList"/,
  );
  assert.match(appSource, /openNotificationMemberNotificationCenter/);
  assert.match(appSource, /countUnreadAlerts\(notificationMemberAlerts\)/);
});

test("feedback is a simple private submission with no fake response", () => {
  const feedbackPage = htmlSource.match(
    /id="helpFeedbackPage"[\s\S]*?<\/section>/
  )?.[0];
  assert.ok(feedbackPage, "feedback page should be present");
  assert.match(feedbackPage, /ご意見・フィードバック/);
  assert.match(feedbackPage, /id="feedbackContent"/);
  assert.match(feedbackPage, /送信する/);
  assert.doesNotMatch(feedbackPage, /チャット|スレッド|返信例/);

  assert.match(appSource, /apiUrl\("\/api\/v1\/feedback"\)/);
  assert.match(appSource, /ご意見・フィードバックの内容を入力してください。/);
  assert.match(appSource, /clearFeedbackError/);
  assert.match(htmlSource, /id="notificationCenterError"/);
  assert.match(appSource, /通知を既読にできませんでした。/);
  assert.match(
    appSource,
    /送信しました。返信がある場合は通知でお知らせします。/
  );
  assert.doesNotMatch(appSource, /ダミー返信|自動返信を作成/);
});

test("normal monitoring management hides identity-linking cards but preserves recovery code", () => {
  assert.match(appSource, /accountCard\.classList\.add\("hidden"\)/);
  assert.match(
    appSource,
    /authCard\.classList\.toggle\([\s\S]*?googleScreenMode === "manage"/
  );
  assert.match(htmlSource, /id="googleLoginProviderButton"/);
  assert.match(htmlSource, /id="microsoftLoginProviderButton"/);
  assert.match(htmlSource, /id="appleLoginProviderButton"/);
  assert.match(appSource, /\/api\/v1\/auth\/identities/);
});
