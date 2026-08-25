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
  assert.match(appSource, /\/api\/v1\/auth\/google\/start/);
  assert.match(appSource, /\/api\/v1\/auth\/logout/);
  assert.match(appSource, /credentials:\s*"include"/);
});

test("frontend no longer treats browser storage or a Google access token as login", () => {
  assert.doesNotMatch(appSource, /callNowSession/);
  assert.doesNotMatch(appSource, /sessionStorage/);
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
