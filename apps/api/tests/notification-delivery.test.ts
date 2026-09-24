import { describe, expect, it, vi } from "vitest";
import { mobilePushDeliveryMode } from "../src/modules/device-push/mobile-delivery-planner.js";
import { loadEnvironment } from "../src/config/env.js";
import { OutboxDispatcher } from "../src/modules/mail/reliability/outbox-dispatcher.js";
import { FakeTransport } from "../src/modules/mail/reliability/outbox-transport.js";
import type { OutboxQueue } from "../src/modules/mail/reliability/prisma-outbox-queue.js";
function fakeQueue() {
  return {
    claimOne: vi.fn(async () => ({
      id: "job",
      eventKey: "event",
      leaseToken: "lease",
      leaseGeneration: 1n,
      attempts: 1
    })),
    prepare: vi.fn(),
    finish: vi.fn(async () => true)
  } satisfies OutboxQueue;
}
describe("PR07a feature isolation", () => {
  it("defaults off and rejects invalid modes", () => {
    expect(mobilePushDeliveryMode(undefined)).toBe("off");
    expect(mobilePushDeliveryMode("shadow")).toBe("shadow");
    expect(() => mobilePushDeliveryMode("live")).toThrow(
      "MOBILE_PUSH_DELIVERY_MODE_INVALID"
    );
    expect(loadEnvironment({ APP_ENV: "test" }).MOBILE_PUSH_DELIVERY_MODE).toBe(
      "off"
    );
  });
  it("global off touches neither queue nor planner, even with mobile shadow", async () => {
    const queue = fakeQueue(),
      planner = { plan: vi.fn() };
    expect(
      await new OutboxDispatcher(queue, new FakeTransport(), {
        mobileDeliveryMode: "shadow",
        mobilePlanner: planner
      }).runOnce()
    ).toBe("OFF");
    expect(queue.claimOne).not.toHaveBeenCalled();
    expect(planner.plan).not.toHaveBeenCalled();
  });
  it("shadow does not call legacy prepare, finish or transport", async () => {
    const queue = fakeQueue(),
      planner = { plan: vi.fn(async () => "DISPATCHED" as const) },
      transport = new FakeTransport();
    const send = vi.spyOn(transport, "send");
    expect(
      await new OutboxDispatcher(queue, transport, {
        mode: "fake",
        mobileDeliveryMode: "shadow",
        mobilePlanner: planner
      }).runOnce()
    ).toBe("DISPATCHED");
    expect(planner.plan).toHaveBeenCalledTimes(1);
    expect(queue.prepare).not.toHaveBeenCalled();
    expect(queue.finish).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it("missing planner fails before claiming; abort does not start work", async () => {
    const queue = fakeQueue();
    const w = new OutboxDispatcher(queue, new FakeTransport(), {
      mode: "fake",
      mobileDeliveryMode: "shadow"
    });
    await expect(w.runOnce()).rejects.toThrow("MOBILE_PLANNER_REQUIRED");
    expect(queue.claimOne).not.toHaveBeenCalled();
    const cancellation = new AbortController();
    cancellation.abort();
    expect(await w.runOnce(cancellation.signal)).toBe("STOPPED");
  });
  it("mobile off never invokes planner, preserving existing Fake dispatch", async () => {
    const queue = fakeQueue(),
      planner = { plan: vi.fn() },
      transport = new FakeTransport();
    queue.prepare.mockResolvedValue({
      outboxId: "job",
      eventKey: "event",
      teamId: "team",
      alertId: "alert",
      recipientId: "recipient",
      attemptId: "attempt"
    });
    const send = vi.spyOn(transport, "send");
    expect(
      await new OutboxDispatcher(queue, transport, {
        mode: "fake",
        mobilePlanner: planner
      }).runOnce()
    ).toBe("DISPATCHED");
    expect(send).toHaveBeenCalledTimes(1);
    expect(planner.plan).not.toHaveBeenCalled();
    expect(queue.finish).toHaveBeenCalledTimes(1);
  });
});
