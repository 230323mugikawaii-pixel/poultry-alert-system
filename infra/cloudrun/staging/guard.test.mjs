import { test } from "node:test";
import assert from "node:assert/strict";
import { project, socket, stagingDatabase } from "./guard.mjs";
const env = { APP_ENV: "staging", STAGING_PROJECT_ID: project };
const url = new URL("postgresql://callnow_migrator@localhost/callnow_staging");
url.password = "test_only_not_a_secret_".padEnd(48, "0");
url.searchParams.set("host", socket);
test("accepts only the new staging project socket and allowed role", () => {
  assert.equal(stagingDatabase(env, url.href, ["callnow_migrator"]).username, "callnow_migrator");
});
test("rejects production, existing-project sockets, other databases and roles", () => {
  assert.throws(() => stagingDatabase({ ...env, APP_ENV: "production" }, url.href, ["callnow_migrator"]));
  for (const value of [url.href.replace("callnow_staging", "callnow"), url.href.replace(project, "call-now-504311"), url.href.replace("localhost", "127.0.0.1")])
    assert.throws(() => stagingDatabase(env, value, ["callnow_migrator"]));
  assert.throws(() => stagingDatabase(env, url.href, ["postgres"]));
});
