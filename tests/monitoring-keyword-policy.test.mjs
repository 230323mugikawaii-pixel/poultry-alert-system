import assert from "node:assert/strict";
import test from "node:test";

import monitoringKeywordPolicy from "../js/monitoring-keyword-policy.js";

function connection(overrides) {
  return {
    provider: "GOOGLE",
    connectionStatus: "PAUSED",
    authorizationStatus: "ACTIVE",
    keywords: [],
    ...overrides
  };
}

test("uses keywords from only the active authorized Google connection", () => {
  const accountA = connection({
    connectionStatus: "ACTIVE",
    keywords: [" A専用 ", "共通"]
  });
  const accountB = connection({ keywords: ["B専用"] });

  assert.deepEqual(
    monitoringKeywordPolicy.getActiveGoogleKeywords([accountA, accountB]),
    ["A専用", "共通"]
  );
});

test("changes test keywords when monitoring switches from A to B", () => {
  const accountA = connection({
    connectionStatus: "ACTIVE",
    keywords: ["A専用"]
  });
  const accountB = connection({ keywords: ["B専用"] });

  accountA.connectionStatus = "PAUSED";
  accountB.connectionStatus = "ACTIVE";

  assert.deepEqual(
    monitoringKeywordPolicy.getActiveGoogleKeywords([accountA, accountB]),
    ["B専用"]
  );
});

test("ignores paused, reauthorization-required, and Microsoft connections", () => {
  assert.deepEqual(
    monitoringKeywordPolicy.getActiveGoogleKeywords([
      connection({ keywords: ["停止中"] }),
      connection({
        connectionStatus: "ACTIVE",
        authorizationStatus: "REAUTH_REQUIRED",
        keywords: ["再認証待ち"]
      }),
      connection({
        provider: "MICROSOFT",
        connectionStatus: "ACTIVE",
        keywords: ["Microsoft専用"]
      })
    ]),
    []
  );
});
