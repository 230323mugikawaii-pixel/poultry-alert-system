import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const appSource = readFileSync(
  new URL("../js/app.js", import.meta.url),
  "utf8",
);
const htmlSource = readFileSync(
  new URL("../index.html", import.meta.url),
  "utf8",
);

test("owner participant management keeps the simple add and list flow", () => {
  const management = htmlSource.match(
    /id="notificationMemberManagementCard"[\s\S]*?<\/article>/,
  )?.[0];
  assert.ok(management, "participant management card should be present");
  assert.match(management, />\s*参加者を追加\s*</);
  assert.match(management, /表示名（任意）/);
  assert.match(management, />\s*IDとパスワードを発行\s*</);
  assert.match(management, /参加者一覧/);
  assert.match(appSource, /currentTeam\?\.role === "OWNER"/);
  assert.match(appSource, /現在の利用人数上限に達しています。/);
  assert.match(htmlSource, /id="notificationMemberActionError"/);
  assert.match(appSource, /参加者情報を読み込めませんでした。再読み込みしてください。/);
  assert.match(appSource, /この参加者を再び有効にするための空き枠がありません。/);
  assert.match(appSource, /この参加者はすでに削除されています。/);
  assert.match(appSource, /refreshNotificationMemberManagement/);
  assert.match(appSource, /参加者はまだ登録されていません。/);
  assert.match(appSource, /1 \+ seats\.occupiedAdditionalSeats/);
  assert.match(appSource, /pageId === "contractPage"/);
});

test("credentials are one-time, copyable, and kept out of browser storage", () => {
  assert.match(htmlSource, /id="notificationMemberCredentialPanel"/);
  assert.match(htmlSource, />\s*IDをコピー\s*</);
  assert.match(htmlSource, />\s*パスワードをコピー\s*</);
  assert.match(htmlSource, />\s*IDとパスワードをまとめてコピー\s*</);
  assert.match(htmlSource, /この画面を閉じると再表示できません/);

  const credentialFunctions = appSource.match(
    /function showNotificationMemberCredential[\s\S]*?function calculateRemainingDays/,
  )?.[0];
  assert.ok(credentialFunctions, "credential functions should be present");
  assert.match(credentialFunctions, /notificationMemberCredential = null/);
  assert.match(credentialFunctions, /navigator\.clipboard\?\.writeText/);
  assert.doesNotMatch(credentialFunctions, /localStorage|sessionStorage/);
  assert.doesNotMatch(credentialFunctions, /console\.(?:log|info|warn|error)/);
});

test("guest participant login stays password-based without OAuth", () => {
  const login = htmlSource.match(
    /id="notificationMemberLoginScreen"[\s\S]*?<\/section>/,
  )?.[0];
  assert.ok(login, "participant login should be present");
  assert.match(login, /参加者ID/);
  assert.match(login, /type="password"/);
  assert.doesNotMatch(login, /Google|Microsoft|OAuth/);
  assert.match(appSource, /\/api\/v1\/notification-members\/login/);
});

test("participant management uses only the existing team APIs", () => {
  assert.match(
    appSource,
    /\/api\/v1\/teams\/\$\{encodeURIComponent\(currentTeam\.id\)\}\/notification-members/,
  );
  assert.match(appSource, /\/password-reset/);
  assert.match(appSource, /\/reactivate/);
  assert.match(appSource, /\/record/);
  assert.match(appSource, /再び有効にする/);
  assert.match(appSource, /過去の通知履歴は保持されます。/);
  assert.doesNotMatch(appSource, /participantPassword|participantCredential/);
});
