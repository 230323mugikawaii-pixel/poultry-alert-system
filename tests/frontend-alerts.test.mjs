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
  assert.match(appSource, /void acknowledgeCurrentAlarm\(\)/);
  assert.match(appSource, /acknowledgedByName/);
  assert.match(
    appSource,
    /すでに\$\{acknowledgedByName\}さんが対応を開始しています/,
  );
  assert.match(appSource, />対応を開始<\/button>/);
  assert.doesNotMatch(appSource, /対応を開始して通知音を停止/);
  assert.doesNotMatch(appSource, /serviceWorker\.register/);
});

test("local alarm stop and shared acknowledgement are separate actions", () => {
  assert.match(htmlSource, /id="stopAlarmButton"/);
  assert.match(htmlSource, /この端末の通知音を停止/);
  assert.match(htmlSource, /id="acknowledgeAlarmButton"/);
  assert.match(
    htmlSource,
    /「対応を開始」は全利用者に共有されます。/,
  );

  const localStopFunction = appSource.match(
    /function stopCurrentAlarmLocally\(\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(localStopFunction, "local alarm stop handler should be present");
  assert.match(localStopFunction, /closeAlarmNotification\(\)/);
  assert.doesNotMatch(
    localStopFunction,
    /acknowledgeAlert|resolveAlert|fetch\(/,
  );

  const sharedAcknowledgeFunction = appSource.match(
    /async function acknowledgeCurrentAlarm\(\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(
    sharedAcknowledgeFunction,
    "shared acknowledgement handler should be present",
  );
  assert.match(sharedAcknowledgeFunction, /acknowledgeAlert\(/);
  assert.match(appSource, /acknowledgingAlertIds\.has\(alertId\)/);
  assert.match(appSource, /acknowledgingAlertIds\.add\(alertId\)/);
  assert.match(appSource, /acknowledgingAlertIds\.delete\(alertId\)/);
});

test("escape and sound preference changes remain local-only", () => {
  const escapeFunction = appSource.match(
    /function handleAlarmModalKeydown\(event\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(escapeFunction, "alarm Escape handler should be present");
  assert.match(escapeFunction, /event\.key !== "Escape"/);
  assert.match(escapeFunction, /closeAlarmNotification\(\)/);
  assert.doesNotMatch(escapeFunction, /acknowledgeAlert|resolveAlert|fetch\(/);

  const soundToggleFunction = appSource.match(
    /async function toggleAlarmSoundPreference\(audience\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(soundToggleFunction, "sound preference handler should be present");
  assert.match(soundToggleFunction, /stopAlarmSound\(\)/);
  assert.doesNotMatch(
    soundToggleFunction,
    /acknowledgeAlert|resolveAlert|fetch\(/,
  );

  const closeFunction = appSource.match(
    /function closeAlarmNotification\(\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(closeFunction, "local modal close handler should be present");
  assert.match(closeFunction, /stopAlarmSound\(\)/);
  assert.doesNotMatch(closeFunction, /acknowledgeAlert|resolveAlert|fetch\(/);
});

test("REAL and TEST alerts share the separated modal actions", () => {
  const showFunction = appSource.match(
    /function showAlarmNotification\([\s\S]*?\n\}\n\n\nfunction closeAlarmNotification/,
  )?.[0];
  assert.ok(showFunction, "alarm modal renderer should be present");
  assert.match(showFunction, /alertContext\?\.kind === "TEST"/);
  assert.match(showFunction, /この端末の通知音を停止/);
  assert.match(showFunction, /acknowledgeAlarmButton/);
  assert.doesNotMatch(showFunction, /acknowledgeAlert\(/);
});

test("SSE reconnects with list refresh, fallback polling, and alert-id deduplication", () => {
  assert.match(appSource, /stream\.onopen\s*=\s*\(\)\s*=>/);
  assert.match(appSource, /接続しています…/);
  assert.match(appSource, /setAlertStreamStatus\([\s\S]*?"接続中"/);
  assert.match(appSource, /markAlertStreamDisconnected/);
  assert.match(
    appSource,
    /リアルタイム接続が切れています。自動で再接続しています。/,
  );
  assert.match(appSource, /startAlertFallbackPolling/);
  assert.match(appSource, /ALERT_FALLBACK_DELAY_MS/);
  assert.match(appSource, /ALERT_FALLBACK_INTERVAL_MS/);
  assert.match(appSource, /stopAlertFallbackPolling/);
  assert.match(appSource, /refreshAlertsForAudience/);
  assert.match(appSource, /rememberNotifiedAlert\(nextAlert\.id\)/);
  assert.match(appSource, /window\.sessionStorage\.setItem/);
  assert.match(appSource, /stream-error/);
  assert.match(appSource, /handleAlertSessionEnded/);
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

test("owner and participant screens provide persistent sound controls", () => {
  assert.match(htmlSource, /id="ownerEnableAudioButton"/);
  assert.match(htmlSource, /id="notificationMemberEnableAudioButton"/);
  assert.match(htmlSource, /id="ownerSoundToggleButton"/);
  assert.match(htmlSource, /id="notificationMemberSoundToggleButton"/);
  assert.match(appSource, /updateAlarmAudioReadiness/);
  assert.match(appSource, /unlockAlarmAudio/);
  assert.match(appSource, /toggleAlarmSoundPreference/);
  assert.match(appSource, /ALERT_SOUND_SETTING_KEY/);
  assert.match(appSource, /window\.localStorage\.setItem/);
  assert.match(appSource, /window\.addEventListener\(\s*"storage"/);
  assert.match(appSource, /通知音はOFFです。画面通知は受信しています。/);
  assert.match(appSource, /if \(!alarmSoundEnabled\)/);
  assert.match(appSource, /stopAlarmSound\(\)/);
  assert.match(appSource, /updateAlarmModalSoundStatus/);
  assert.doesNotMatch(
    appSource,
    /localStorage\.setItem\([^)]*(?:token|password|cookie)/iu,
  );
});
