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

test("frontend authentication uses the server session API", () => {
  assert.match(appSource, /\/api\/v1\/auth\/me/);
  assert.match(
    appSource,
    /\/api\/v1\/auth\/\$\{provider\.toLowerCase\(\)\}\/start/
  );
  assert.match(appSource, /\/api\/v1\/auth\/logout/);
  assert.match(appSource, /credentials:\s*"include"/);
  assert.match(appSource, /\/api\/v1\/teams\/bootstrap/);
  assert.doesNotMatch(appSource, /ログインしてホームへ/);
  assert.doesNotMatch(htmlSource, /ログインしてホームへ/);
  assert.doesNotMatch(htmlSource, /id="landingScreen"/);
  assert.match(htmlSource, /id="guestHomeScreen"/);
  assert.match(htmlSource, /まだ設定されていません/);
  assert.match(appSource, /\/api\/v1\/notification-members\/me/);
  assert.match(appSource, /\/api\/v1\/notification-members\/login/);
});

test("frontend no longer treats browser storage or a Google access token as login", () => {
  assert.doesNotMatch(appSource, /callNowSession/);
  assert.doesNotMatch(
    appSource,
    /sessionStorage\.(?:getItem|setItem)\(\s*["'](?:callNowSession|googleAccessToken)/
  );
  assert.doesNotMatch(appSource, /googleAccessToken/);
  assert.doesNotMatch(appSource, /initTokenClient/);
  assert.doesNotMatch(appSource, /gmail\.readonly/);
  assert.doesNotMatch(htmlSource, /accounts\.google\.com\/gsi\/client/);
});

test("active contract storage does not persist the authenticated email", () => {
  const saveFunction = appSource.match(
    /function saveData\(\) \{([\s\S]*?)localStorage\.setItem/
  )?.[1];
  assert.ok(saveFunction, "saveData should be present");
  assert.doesNotMatch(saveFunction, /googleEmail/);
});
