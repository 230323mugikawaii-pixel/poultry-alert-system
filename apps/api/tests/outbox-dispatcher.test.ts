import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OutboxDispatcher,
  outboxDispatchMode,
  retryDelayMs
} from "../src/modules/mail/reliability/outbox-dispatcher.js";
import {
  FakeTransport,
  type OutboxTransport
} from "../src/modules/mail/reliability/outbox-transport.js";
import type {
  OutboxQueue,
  OutboxClaim
} from "../src/modules/mail/reliability/prisma-outbox-queue.js";

const claim: OutboxClaim = {
  id: "job",
  eventKey: "key",
  leaseToken: "attempt",
  leaseGeneration: 1n,
  attempts: 1
};
function fixture(attempts = 1) {
  const queue = {
    claimOne: vi.fn(async () => ({ ...claim, attempts })),
    prepare: vi.fn(async () => ({
      outboxId: "job",
      eventKey: "key",
      teamId: "team",
      alertId: "alert",
      recipientId: "recipient",
      attemptId: "attempt"
    })),
    finish: vi.fn<OutboxQueue["finish"]>(async () => true)
  } satisfies OutboxQueue;
  return queue;
}
describe("PR03a fake-only Outbox dispatcher", () => {
  afterEach(() => vi.useRealTimers());
  it("defaults off, performs no database/transport work; rejects unknown mode", async () => {
    const queue = fixture();
    const transport = new FakeTransport();
    const send = vi.spyOn(transport, "send");
    expect(outboxDispatchMode(undefined)).toBe("off");
    expect(outboxDispatchMode("off")).toBe("off");
    expect(outboxDispatchMode("fake")).toBe("fake");
    expect(() => outboxDispatchMode("apns")).toThrow(
      "OUTBOX_DISPATCH_MODE_INVALID"
    );
    expect(await new OutboxDispatcher(queue, transport).runOnce()).toBe("OFF");
    expect(queue.claimOne).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it("fake completion is separate from provider acceptance; no body/payload passed", async () => {
    const queue = fixture();
    const transport = new FakeTransport();
    const send = vi.spyOn(transport, "send");
    expect(
      await new OutboxDispatcher(queue, transport, { mode: "fake" }).runOnce()
    ).toBe("DISPATCHED");
    expect(Object.keys(send.mock.calls[0]![0]).sort()).toEqual(
      [
        "outboxId",
        "eventKey",
        "teamId",
        "alertId",
        "recipientId",
        "attemptId"
      ].sort()
    );
    expect(queue.finish).toHaveBeenCalledExactlyOnceWith(claim, {
      status: "DISPATCHED"
    });
  });
  it("backoff is exponential then capped", () => {
    expect([1, 2, 3, 4, 10, 100].map(retryDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 300000, 300000
    ]);
  });
  it.each([
    [{ kind: "RETRY", code: "FAKE_TRANSIENT" }, "RETRY_WAIT", "FAKE_TRANSIENT"],
    [
      { kind: "PERMANENT", code: "FAKE_PERMANENT" },
      "BLOCKED",
      "FAKE_PERMANENT"
    ],
    [
      { kind: "ACCEPTED", providerRequestId: "not-real" },
      "BLOCKED",
      "TRANSPORT_RESULT_INVALID"
    ],
    [
      { kind: "PERMANENT", code: "DO_NOT_PERSIST_ARBITRARY_RESPONSE" },
      "BLOCKED",
      "TRANSPORT_RESULT_INVALID"
    ]
  ])("validates transport result %j", async (result, status, code) => {
    const queue = fixture();
    const transport = {
      mode: "fake",
      send: vi.fn(async () => result)
    } as unknown as OutboxTransport;
    expect(
      await new OutboxDispatcher(queue, transport, { mode: "fake" }).runOnce()
    ).toBe(status);
    expect(queue.finish.mock.calls[0]?.[1]).toMatchObject({ status, code });
  });
  it("unknown error messages are never persisted", async () => {
    const queue = fixture();
    const transport: OutboxTransport = {
      mode: "fake",
      send: async () => {
        throw new Error("SYNTHETIC_PRIVATE_ERROR");
      }
    };
    expect(
      await new OutboxDispatcher(queue, transport, { mode: "fake" }).runOnce()
    ).toBe("RETRY_WAIT");
    expect(queue.finish.mock.calls[0]?.[1]).toEqual({
      status: "RETRY_WAIT",
      code: "TRANSPORT_ERROR",
      delayMs: 1000
    });
  });
  it("timeout aborts, late transport resolution cannot complete the old run", async () => {
    vi.useFakeTimers();
    const queue = fixture();
    let late: (() => void) | undefined;
    let aborted = false;
    const transport: OutboxTransport = {
      mode: "fake",
      send: async (_input, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          late = () => resolve({ kind: "FAKE_COMPLETED" });
        })
    };
    const running = new OutboxDispatcher(queue, transport, {
      mode: "fake",
      timeoutMs: 100,
      leaseMs: 1000
    }).runOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(await running).toBe("RETRY_WAIT");
    expect(aborted).toBe(true);
    expect(queue.finish.mock.calls[0]?.[1]).toMatchObject({
      code: "TRANSPORT_TIMEOUT"
    });
    late?.();
    await vi.advanceTimersByTimeAsync(2000);
    expect(queue.finish).toHaveBeenCalledTimes(1);
  });
  it("shutdown aborts and leaves unfinished work recoverable", async () => {
    const queue = fixture();
    const controller = new AbortController();
    const transport: OutboxTransport = {
      mode: "fake",
      send: async () => {
        controller.abort();
        return { kind: "FAKE_COMPLETED" };
      }
    };
    expect(
      await new OutboxDispatcher(queue, transport, { mode: "fake" }).runOnce(
        controller.signal
      )
    ).toBe("STOPPED");
    expect(queue.finish).not.toHaveBeenCalled();
    expect(
      await new OutboxDispatcher(queue, transport, { mode: "fake" }).runOnce(
        controller.signal
      )
    ).toBe("STOPPED");
    expect(queue.claimOne).toHaveBeenCalledTimes(1);
  });
  it("retry budget exhausted retains BLOCKED work, reclaimed crash budget never sends", async () => {
    const queue = fixture(10);
    const send = vi.fn<OutboxTransport["send"]>(async () => ({
      kind: "RETRY",
      code: "FAKE_TRANSIENT"
    }));
    const transport: OutboxTransport = {
      mode: "fake",
      send
    };
    expect(
      await new OutboxDispatcher(queue, transport, { mode: "fake" }).runOnce()
    ).toBe("BLOCKED");
    expect(queue.finish.mock.calls[0]?.[1]).toEqual({
      status: "BLOCKED",
      code: "RETRY_EXHAUSTED"
    });
    const reclaimed = fixture(11);
    expect(
      await new OutboxDispatcher(reclaimed, transport, {
        mode: "fake"
      }).runOnce()
    ).toBe("BLOCKED");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("rejects results when lease is lost, and invalid timeout/lease combinations", async () => {
    const queue = fixture();
    queue.finish.mockResolvedValue(false);
    expect(
      await new OutboxDispatcher(queue, new FakeTransport(), {
        mode: "fake"
      }).runOnce()
    ).toBe("LEASE_LOST");
    expect(
      () =>
        new OutboxDispatcher(queue, new FakeTransport(), {
          leaseMs: 1000,
          timeoutMs: 1000
        })
    ).toThrow("OUTBOX_WORKER_OPTIONS_INVALID");
  });
});
