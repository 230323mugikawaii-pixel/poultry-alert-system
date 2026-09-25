import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createPushDeliveryWorker,
  PushDeliveryWorker,
  pushOutcome
} from "../src/modules/device-push/push-delivery-worker.js";
import {
  FakePushTransport,
  pushIdempotencyKey,
  type PushTransport,
  type PushTransportResult
} from "../src/modules/device-push/push-transport.js";
import type { PushDeliveryQueue } from "../src/modules/device-push/prisma-push-delivery-queue.js";
import { PrismaPushDeliveryQueue } from "../src/modules/device-push/prisma-push-delivery-queue.js";
import type { DatabaseClient } from "../src/db/client.js";

const input = {
  deliveryId: randomUUID(),
  idempotencyKey: pushIdempotencyKey(randomUUID(), randomUUID(), 1),
  alertId: randomUUID(),
  recipientId: randomUUID(),
  endpointKey: randomUUID(),
  endpointVersion: 1,
  attemptId: randomUUID()
};
const fakeQueue = () =>
  ({
    claimOne: vi.fn(async () => ({
      id: input.deliveryId,
      leaseToken: input.attemptId,
      leaseGeneration: 1n,
      attemptCount: 1
    })),
    prepare: vi.fn(async () => input),
    finish: vi.fn(async () => true)
  }) satisfies PushDeliveryQueue;
describe("PR07b Fake push delivery boundary", () => {
  it("database exceptions are replaced without a raw cause or parameters", async () => {
    const database = {
      $queryRaw: async () => {
        throw new Error("PRIVATE_DATABASE_PARAMETERS");
      }
    } as unknown as DatabaseClient;
    try {
      await new PrismaPushDeliveryQueue(database).claimOne(1000);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("PUSH_DELIVERY_DATABASE_ERROR");
      expect((error as Error).cause).toBeUndefined();
    }
  });
  it("off factory does not build queue/transport and off worker never accesses them", async () => {
    const dependencies = vi.fn();
    expect(createPushDeliveryWorker("off", dependencies)).toBeUndefined();
    expect(dependencies).not.toHaveBeenCalled();
    const q = fakeQueue(),
      transport = new FakePushTransport(),
      send = vi.spyOn(transport, "send");
    expect(await new PushDeliveryWorker(q, transport).runOnce()).toBe("OFF");
    expect(q.claimOne).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it("off CLI exits without a database; production shadow refuses startup", () => {
    const path = fileURLToPath(
      new URL("../src/cli/push-deliveries.ts", import.meta.url)
    );
    const off = spawnSync(
      process.execPath,
      ["--import", "tsx", path, "--once"],
      {
        env: {
          ...process.env,
          DATABASE_URL: "",
          MOBILE_PUSH_DELIVERY_MODE: "off"
        },
        encoding: "utf8"
      }
    );
    expect(off.status).toBe(0);
    expect(off.stdout).toContain("OFF; no database or transport access");
    expect(off.stderr).toBe("");
    const prod = spawnSync(
      process.execPath,
      ["--import", "tsx", path, "--once"],
      {
        env: {
          ...process.env,
          DATABASE_URL: "",
          APP_ENV: "production",
          MOBILE_PUSH_DELIVERY_MODE: "shadow"
        },
        encoding: "utf8"
      }
    );
    expect(prod.status).toBe(1);
    expect(prod.stderr).toBe("PUSH_WORKER_STARTUP_FAILED\n");
  });
  it("Fake receipts remain stable across attempts and new transport instances, version separates them", async () => {
    const signal = new AbortController().signal;
    const first = await new FakePushTransport().send(input, signal);
    expect(
      await new FakePushTransport().send(
        { ...input, attemptId: randomUUID() },
        signal
      )
    ).toEqual(first);
    expect(
      await new FakePushTransport().send(
        {
          ...input,
          idempotencyKey: pushIdempotencyKey(randomUUID(), input.endpointKey, 2)
        },
        signal
      )
    ).not.toEqual(first);
    const outbox = randomUUID(),
      target = randomUUID();
    expect(
      pushIdempotencyKey(outbox.toUpperCase(), target.toUpperCase(), 1)
    ).toBe(pushIdempotencyKey(outbox, target, 1));
  });
  it("real transport mode is rejected before claim", async () => {
    const q = fakeQueue(),
      transport = { mode: "real", send: vi.fn() } as unknown as PushTransport;
    await expect(
      new PushDeliveryWorker(q, transport, { mode: "shadow" }).runOnce()
    ).rejects.toThrow("PUSH_REAL_TRANSPORT_FORBIDDEN");
    expect(q.claimOne).not.toHaveBeenCalled();
  });
  it.each(["HTTP_429", "HTTP_5XX", "FAKE_TRANSIENT"])(
    "normalizes %s with exponential/provider delay",
    (code) => {
      expect(
        pushOutcome({ kind: "RETRY", code, retryAfterMs: 9000 }, 2)
      ).toEqual({ state: "RETRY_WAIT", code, delayMs: 9000 });
      expect(pushOutcome({ kind: "RETRY", code, retryAfterMs: 0 }, 10)).toEqual(
        { state: "RETRY_WAIT", code, delayMs: 300000 }
      );
    }
  );
  it("unknown errors/invalid retry values and receipt are sanitized, never persisted raw", () => {
    for (const result of [
      { kind: "RETRY", code: "PRIVATE_PROVIDER_TEXT", retryAfterMs: 0 },
      ...[-1, Infinity, NaN, 604800001, 0.5].map((retryAfterMs) => ({
        kind: "RETRY",
        code: "HTTP_429",
        retryAfterMs
      })),
      { kind: "PERMANENT", code: "PRIVATE_PROVIDER_TEXT" },
      { kind: "ACCEPTED", providerRequestId: "PRIVATE_PROVIDER_TEXT" },
      null
    ])
      expect(pushOutcome(result as PushTransportResult, 1)).toEqual({
        state: "PERMANENT_FAILURE",
        code: "TRANSPORT_RESULT_INVALID"
      });
  });
  it("throwing provider produces safe retry; exhausted attempts do not send", async () => {
    const q = fakeQueue(),
      transport = {
        mode: "fake" as const,
        send: vi.fn(async () => {
          throw new Error("PRIVATE_PROVIDER_TEXT");
        })
      };
    expect(
      await new PushDeliveryWorker(q, transport, { mode: "shadow" }).runOnce()
    ).toBe("RETRY_WAIT");
    expect(q.finish).toHaveBeenCalledWith(expect.anything(), {
      state: "RETRY_WAIT",
      code: "TRANSPORT_ERROR",
      delayMs: 1000
    });
    transport.send.mockClear();
    q.claimOne.mockResolvedValue({
      id: input.deliveryId,
      leaseToken: input.attemptId,
      leaseGeneration: 2n,
      attemptCount: 11
    });
    expect(
      await new PushDeliveryWorker(q, transport, { mode: "shadow" }).runOnce()
    ).toBe("PERMANENT_FAILURE");
    expect(transport.send).not.toHaveBeenCalled();
  });
  it("late transport success after timeout cannot finish twice", async () => {
    const q = fakeQueue();
    let resolve: ((result: PushTransportResult) => void) | undefined;
    const transport = {
      mode: "fake" as const,
      send: vi.fn(
        () =>
          new Promise<PushTransportResult>((done) => {
            resolve = done;
          })
      )
    };
    expect(
      await new PushDeliveryWorker(q, transport, {
        mode: "shadow",
        timeoutMs: 10
      }).runOnce()
    ).toBe("RETRY_WAIT");
    resolve?.({ kind: "ACCEPTED", providerRequestId: randomUUID() });
    await Promise.resolve();
    expect(q.finish).toHaveBeenCalledTimes(1);
    expect(q.finish).toHaveBeenCalledWith(expect.anything(), {
      state: "RETRY_WAIT",
      code: "TRANSPORT_TIMEOUT",
      delayMs: 1000
    });
  });
  it("aborted before/after claim never sends; invalid options rejected", async () => {
    const q = fakeQueue(),
      transport = new FakePushTransport(),
      send = vi.spyOn(transport, "send"),
      stop = new AbortController();
    stop.abort();
    expect(
      await new PushDeliveryWorker(q, transport, { mode: "shadow" }).runOnce(
        stop.signal
      )
    ).toBe("STOPPED");
    expect(q.claimOne).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(
      () =>
        new PushDeliveryWorker(q, transport, { leaseMs: 100, timeoutMs: 100 })
    ).toThrow("PUSH_WORKER_OPTIONS_INVALID");
  });
});
