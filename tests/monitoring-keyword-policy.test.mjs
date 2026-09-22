import assert from "node:assert/strict";
import test from "node:test";

import monitoringKeywordPolicy from "../js/monitoring-keyword-policy.js";
import mailConnectionRefresh from "../js/mail-connection-refresh.js";

function connection(overrides) {
  return {
    provider: "GOOGLE",
    connectionStatus: "PAUSED",
    authorizationStatus: "ACTIVE",
    keywords: [],
    ...overrides,
  };
}

test("uses keywords from only the active authorized Google connection", () => {
  const accountA = connection({
    connectionStatus: "ACTIVE",
    keywords: [" A専用 ", "共通"],
  });
  const accountB = connection({ keywords: ["B専用"] });

  assert.deepEqual(
    monitoringKeywordPolicy.getActiveGoogleKeywords([accountA, accountB]),
    ["A専用", "共通"],
  );
});

test("changes test keywords when monitoring switches from A to B", () => {
  const accountA = connection({
    connectionStatus: "ACTIVE",
    keywords: ["A専用"],
  });
  const accountB = connection({ keywords: ["B専用"] });

  accountA.connectionStatus = "PAUSED";
  accountB.connectionStatus = "ACTIVE";

  assert.deepEqual(
    monitoringKeywordPolicy.getActiveGoogleKeywords([accountA, accountB]),
    ["B専用"],
  );
});

test("ignores paused, reauthorization-required, and Microsoft connections", () => {
  assert.deepEqual(
    monitoringKeywordPolicy.getActiveGoogleKeywords([
      connection({ keywords: ["停止中"] }),
      connection({
        connectionStatus: "ACTIVE",
        authorizationStatus: "REAUTH_REQUIRED",
        keywords: ["再認証待ち"],
      }),
      connection({
        provider: "MICROSOFT",
        connectionStatus: "ACTIVE",
        keywords: ["Microsoft専用"],
      }),
    ]),
    [],
  );
});

test("mail connection refresh applies only the newest response", async () => {
  const pending = [];
  const readyValues = [];
  const coordinator = mailConnectionRefresh.createCoordinator({
    load: () =>
      new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    onStateChange: (state, value) => {
      if (state.status === "ready") readyValues.push(value);
    },
    now: () => 123,
  });

  const first = coordinator.refresh({ reason: "first" });
  const second = coordinator.refresh({ reason: "second" });
  pending[1].resolve([{ id: "new" }]);
  await second;
  pending[0].resolve([{ id: "old" }]);
  await first;

  assert.deepEqual(readyValues, [[{ id: "new" }]]);
  assert.deepEqual(coordinator.getState(), {
    status: "ready",
    reason: "second",
    confirmedAt: 123,
  });
});

test("mail connection refresh exposes failure instead of stale readiness", async () => {
  let shouldFail = false;
  const states = [];
  const coordinator = mailConnectionRefresh.createCoordinator({
    load: async () => {
      if (shouldFail) throw new Error("offline");
      return [{ id: "confirmed" }];
    },
    onStateChange: (state) => states.push(state.status),
    now: () => 456,
  });

  await coordinator.refresh({ reason: "initial" });
  shouldFail = true;
  const failed = await coordinator.refresh({
    reason: "network-online",
    showLoading: false,
  });

  assert.equal(failed.ok, false);
  assert.equal(coordinator.getState().status, "error");
  assert.equal(coordinator.getState().confirmedAt, 456);
  assert.deepEqual(states, ["loading", "ready", "error"]);
});

test("invalidating a switch prevents an older request from restoring its state", async () => {
  let finishOldRequest;
  const readyValues = [];
  const coordinator = mailConnectionRefresh.createCoordinator({
    load: () =>
      new Promise((resolve) => {
        finishOldRequest = resolve;
      }),
    onStateChange: (state, value) => {
      if (state.status === "ready") readyValues.push(value);
    },
  });

  const oldRequest = coordinator.refresh({ reason: "poll" });
  coordinator.invalidate("monitoring-resume");
  finishOldRequest([{ id: "stale-active-account" }]);
  await oldRequest;

  assert.deepEqual(readyValues, []);
  assert.equal(coordinator.getState().status, "loading");
  assert.equal(coordinator.getState().reason, "monitoring-resume");
});
