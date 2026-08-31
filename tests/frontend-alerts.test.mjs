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
const cssSource = readFileSync(
  new URL("../css/style.css", import.meta.url),
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

test("in-app alert updates use credentialed SSE without acknowledgement UI", () => {
  assert.match(
    appSource,
    /new EventSource\(\s*apiUrl\(path\),\s*\{\s*withCredentials:\s*true/,
  );
  assert.match(appSource, /currentAlarmAlertContext/);
  assert.doesNotMatch(appSource, /acknowledgeAlert|acknowledgeCurrentAlarm/);
  assert.doesNotMatch(appSource, /\/alerts\/[^\s]*\/acknowledge/);
  assert.doesNotMatch(appSource, /対応を開始/);
  assert.doesNotMatch(htmlSource, /対応を開始/);
  assert.match(appSource, /resolveAlert/);
  assert.match(appSource, /対応完了にする/);
  assert.doesNotMatch(appSource, /serviceWorker\.register/);
});

test("local alarm stop is the only alarm modal action", () => {
  assert.match(htmlSource, /id="stopAlarmButton"/);
  assert.match(htmlSource, /この端末の通知音を停止/);
  assert.doesNotMatch(htmlSource, /id="acknowledgeAlarmButton"/);
  assert.match(htmlSource, /代表者が対応完了にするまで残ります/);

  const localStopFunction = appSource.match(
    /function stopCurrentAlarmLocally\(\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(localStopFunction, "local alarm stop handler should be present");
  assert.match(localStopFunction, /closeAlarmNotification\(\)/);
  assert.doesNotMatch(
    localStopFunction,
    /acknowledgeAlert|resolveAlert|fetch\(/,
  );
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
  assert.match(soundToggleFunction, /closeAlarmNotification\(\)/);
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
  assert.doesNotMatch(showFunction, /acknowledge|resolve|fetch\(/);
});

test("sound-off alerts update lists and badges without opening the alarm", () => {
  const updateFunction = appSource.match(
    /function applyAlertUpdate\([\s\S]*?\n}\n\nfunction renderAlertList/,
  )?.[0];
  assert.ok(updateFunction, "alert update handler should be present");
  assert.match(updateFunction, /renderAlertList/);
  assert.match(updateFunction, /renderEmergencyNotifications/);
  assert.match(updateFunction, /renderNotificationBadge/);
  assert.match(updateFunction, /if \(alarmSoundEnabled\)/);
  assert.match(updateFunction, /showAlarmNotification/);
  assert.match(updateFunction, /rememberNotifiedAlert\(nextAlert\.id\)/);
});

test("owner and participant bells keep recipient read state separate", () => {
  assert.match(htmlSource, /id="notificationCenterButton"/);
  assert.match(htmlSource, /id="notificationMemberNotificationCenterButton"/);
  assert.match(htmlSource, /id="ownerEmergencyNotificationList"/);
  assert.match(
    htmlSource,
    /id="notificationMemberEmergencyNotificationList"/,
  );
  assert.match(htmlSource, />緊急通知</);
  assert.match(htmlSource, />お知らせ</);
  assert.match(appSource, /markEmergencyAlertRead/);
  assert.match(
    appSource,
    /\/alerts\/\$\{encodeURIComponent\(alertId\)\}\/read/,
  );
  assert.match(appSource, /alert\.readAt/);
  assert.match(appSource, /unreadCount > 99[\s\S]*?"99\+"/);
});

test("alert notification center fits the 390px layout", () => {
  assert.match(cssSource, /@media \(max-width: 390px\)/);
  assert.match(
    cssSource,
    /@media \(max-width: 390px\)[\s\S]*?\.app-header \{[\s\S]*?padding-right: 12px;[\s\S]*?padding-left: 12px;/,
  );
  assert.match(
    cssSource,
    /@media \(max-width: 390px\)[\s\S]*?\.notification-bell-button \{[\s\S]*?min-width: 42px;/,
  );
  assert.match(
    cssSource,
    /@media \(max-width: 390px\)[\s\S]*?\.emergency-notification-item \{[\s\S]*?min-width: 0;/,
  );
  assert.match(
    cssSource,
    /\.emergency-notification-heading \{[\s\S]*?flex-wrap: wrap;/,
  );
  assert.match(
    cssSource,
    /\.emergency-notification-item h3 \{[\s\S]*?overflow-wrap: anywhere;/,
  );
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
    /function renderAlertList\([\s\S]*?\n}\n\nasync function resolveAlert/,
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
  assert.match(appSource, /通知音はOFFです。緊急通知はベルから確認できます。/);
  assert.match(appSource, /if \(!alarmSoundEnabled\)/);
  assert.match(appSource, /closeAlarmNotification\(\)/);
  assert.doesNotMatch(
    appSource,
    /localStorage\.setItem\([^)]*(?:token|password|cookie)/iu,
  );
});
