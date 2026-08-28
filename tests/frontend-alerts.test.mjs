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

test("owner and notification member alert views use authenticated APIs", () => {
  assert.match(htmlSource, /id="ownerAlertList"/);
  assert.match(htmlSource, /id="notificationMemberAlertList"/);
  assert.match(appSource, /\/api\/v1\/teams\/\$\{encodeURIComponent\(currentTeam\.id\)\}\/alerts/);
  assert.match(appSource, /\/api\/v1\/notification-members\/alerts/);
  assert.doesNotMatch(appSource, /currentTeam\.teamId/);
});

test("in-app alert updates use credentialed SSE and explicit acknowledgement", () => {
  assert.match(appSource, /new EventSource\(apiUrl\(path\),\s*\{\s*withCredentials:\s*true/);
  assert.match(appSource, /\/alerts\/\$\{encodeURIComponent\(alertId\)\}\/acknowledge/);
  assert.match(appSource, /currentAlarmAlertContext/);
  assert.match(appSource, /void acknowledgeAlert\(/);
  assert.match(appSource, /acknowledgedByName/);
  assert.match(appSource, /すでに\$\{acknowledgedByName\}さんが対応を開始しています/);
  assert.doesNotMatch(appSource, /serviceWorker\.register/);
});

test("notification member alert view does not render mail bodies or credentials", () => {
  const renderFunction = appSource.match(
    /function renderAlertList\([\s\S]*?\n}\n\nasync function acknowledgeAlert/
  )?.[0];
  assert.ok(renderFunction, "renderAlertList should be present");
  assert.doesNotMatch(renderFunction, /body|subject|token|refresh|accessToken/iu);
  assert.match(renderFunction, /matchedKeyword/);
  assert.match(renderFunction, /detectedAt/);
});
