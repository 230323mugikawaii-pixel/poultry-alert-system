import assert from "node:assert/strict";
import test from "node:test";

import notificationTestExecution from "../js/notification-test-execution.js";

test("keeps one notification test run active across UI redraws", () => {
  const states = [];
  const controller = notificationTestExecution.createController({
    onChange: (state) => states.push(state),
  });

  const token = controller.begin("停電");
  assert.equal(typeof token, "number");
  assert.equal(controller.begin("通電"), null);

  controller.transition(token, "WAITING_DETECTION", {
    testId: "test-id",
    requestId: "request-id",
    message: "検知待ち",
  });

  const firstRender = controller.getView();
  const secondRender = controller.getView();
  assert.deepEqual(secondRender, firstRender);
  assert.equal(secondRender.blocked, true);
  assert.equal(secondRender.testId, "test-id");
  assert.equal(secondRender.requestId, "request-id");
  assert.equal(states.at(-1).phase, "WAITING_DETECTION");
});

test("ignores stale completion and allows a new run only after completion", () => {
  const controller = notificationTestExecution.createController();
  const first = controller.begin("停電");
  assert.notEqual(first, null);
  assert.equal(
    controller.complete(first, {
      alertId: "alert-id",
      message: "完了",
    }),
    true,
  );

  const second = controller.begin("警報");
  assert.notEqual(second, null);
  assert.notEqual(second, first);
  assert.equal(
    controller.transition(first, "WAITING_NOTIFICATION", {
      alertId: "stale-alert",
    }),
    false,
  );
  assert.equal(controller.getState().keyword, "警報");
});

test("uses the server retry duration and unlocks without resetting counters", () => {
  let now = Date.parse("2026-09-16T00:00:00.000Z");
  const controller = notificationTestExecution.createController({
    now: () => now,
  });
  const token = controller.begin("停電");
  controller.rateLimit(token, {
    retryAt: "2026-09-16T00:10:00.000Z",
    retryAfterSeconds: 600,
    rateLimit: { limit: 3, windowMinutes: 10 },
  });

  assert.deepEqual(
    {
      phase: controller.getView().phase,
      blocked: controller.getView().blocked,
      remainingSeconds: controller.getView().remainingSeconds,
    },
    { phase: "RATE_LIMITED", blocked: true, remainingSeconds: 600 },
  );
  assert.equal(controller.begin("通電"), null);

  now += 600_000;
  assert.equal(controller.refreshRateLimit(), true);
  assert.equal(controller.getView().blocked, false);
  assert.equal(controller.getState().message, "通知テストを再実行できます。");
});
