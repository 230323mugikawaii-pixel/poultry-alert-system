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

test("owner and notification member alert views use authenticated APIs", () => {
  assert.match(htmlSource, /id="ownerAlertList"/);
  assert.match(htmlSource, /id="notificationMemberAlertList"/);
  assert.match(
    appSource,
    /\/api\/v1\/teams\/\$\{encodeURIComponent\(currentTeam\.id\)\}\/alerts/,
  );
  assert.match(appSource, /\/api\/v1\/notification-members\/alerts/);
  assert.doesNotMatch(appSource, /currentTeam\.teamId/);
});

test("in-app alert updates use credentialed SSE and explicit acknowledgement", () => {
  assert.match(
    appSource,
    /new EventSource\(\s*apiUrl\(path\),\s*\{\s*withCredentials:\s*true/,
  );
  assert.match(
    appSource,
    /\/alerts\/\$\{encodeURIComponent\(alertId\)\}\/acknowledge/,
  );
  assert.match(appSource, /currentAlarmAlertContext/);
  assert.match(appSource, /void acknowledgeAlert\(/);
  assert.match(appSource, /acknowledgedByName/);
  assert.match(
    appSource,
    /すでに\$\{acknowledgedByName\}さんが対応を開始しています/,
  );
  assert.match(appSource, />対応を開始<\/button>/);
  assert.match(appSource, /対応を開始して通知音を停止/);
  assert.doesNotMatch(appSource, /serviceWorker\.register/);
});

test("notification member alert view does not render mail bodies or credentials", () => {
  const renderFunction = appSource.match(
    /function renderAlertList\([\s\S]*?\n}\n\nasync function acknowledgeAlert/,
  )?.[0];
  assert.ok(renderFunction, "renderAlertList should be present");
  assert.doesNotMatch(
    renderFunction,
    /body|subject|token|refresh|accessToken/iu,
  );
  assert.match(renderFunction, /matchedKeyword/);
  assert.match(renderFunction, /detectedAt/);
});

test("notification tests create server TEST alerts instead of opening a local-only alarm", () => {
  const testFunction = appSource.match(
    /async function testNotification\([\s\S]*?\n}\n\nfunction findNotificationTestConnection/,
  )?.[0];
  assert.ok(testFunction, "testNotification should be present");
  assert.match(testFunction, /startServerNotificationTest/);
  assert.match(testFunction, /confirmServerNotificationTest/);
  assert.match(testFunction, /expireServerNotificationTest/);
  assert.doesNotMatch(testFunction, /showAlarmNotification/);
  assert.match(appSource, /\/notification-tests/);
  assert.match(appSource, /alert\.kind === "TEST"/);
  assert.match(htmlSource, /id="alarmKindBadge"/);
  assert.match(htmlSource, /テスト通知/);
});

test("owner and participant screens provide an explicit audio readiness action", () => {
  assert.match(htmlSource, /id="ownerEnableAudioButton"/);
  assert.match(htmlSource, /id="notificationMemberEnableAudioButton"/);
  assert.match(appSource, /updateAlarmAudioReadiness/);
  assert.match(appSource, /unlockAlarmAudio/);
});
