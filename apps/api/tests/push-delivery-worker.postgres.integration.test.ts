import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPushWorkerDatabase,
  pushFixture,
  DurableFakePushTransport
} from "./fixtures/push-worker-harness.js";
import { registry, makeDeviceToken } from "./fixtures/device-push-harness.js";
import {
  deliveryTxProbe,
  oldDeliverySnapshot,
  deliveryFixture
} from "./fixtures/delivery-test-database.js";
import { PrismaPushDeliveryQueue } from "../src/modules/device-push/prisma-push-delivery-queue.js";
import {
  PushDeliveryWorker,
  createPushDeliveryWorker
} from "../src/modules/device-push/push-delivery-worker.js";
import {
  FakePushTransport,
  type PushTransport,
  type PushTransportInput,
  type PushTransportResult
} from "../src/modules/device-push/push-transport.js";
import { OutboxDispatcher } from "../src/modules/mail/reliability/outbox-dispatcher.js";
import { PrismaOutboxQueue } from "../src/modules/mail/reliability/prisma-outbox-queue.js";
import { FakeTransport } from "../src/modules/mail/reliability/outbox-transport.js";

const postgres =
  process.env.RUN_PR07B_POSTGRES_TESTS === "true" ? describe : describe.skip;
const accepted = {
  state: "PROVIDER_ACCEPTED" as const,
  providerRequestId: randomUUID()
};
postgres("PR07b real PostgreSQL Fake push worker", () => {
  let d: Awaited<ReturnType<typeof createPushWorkerDatabase>>;
  beforeEach(async () => {
    d = await createPushWorkerDatabase();
  });
  afterEach(async () => {
    await d?.close();
  });
  const worker = (
    transport: PushTransport = new FakePushTransport(),
    options: { timeoutMs?: number; maximumAttempts?: number } = {}
  ) =>
    new PushDeliveryWorker(new PrismaPushDeliveryQueue(d.db), transport, {
      mode: "shadow",
      ...options
    });
  it("OWNER/MEMBER active targets -> Fake PROVIDER_ACCEPTED, receipt/time saved; old data unchanged", async () => {
    const f = await pushFixture(d.db, 2, 1),
      before = await oldDeliverySnapshot(d.pool);
    const w = worker();
    expect(await w.runOnce()).toBe("PROVIDER_ACCEPTED");
    expect(await w.runOnce()).toBe("PROVIDER_ACCEPTED");
    expect(await w.runOnce()).toBe("PROVIDER_ACCEPTED");
    expect(await w.runOnce()).toBe("IDLE");
    const rows = await d.db.notificationDelivery.findMany();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({
        state: "PROVIDER_ACCEPTED",
        attemptCount: 1,
        leaseToken: null,
        leaseUntil: null,
        lastErrorCode: null
      });
      expect(row.acceptedAt).toBeInstanceOf(Date);
      expect(row.apnsRequestId).toMatch(/^[0-9a-f-]{36}$/u);
    }
    expect(new Set(rows.map((r) => r.apnsRequestId)).size).toBe(3);
    expect(await oldDeliverySnapshot(d.pool)).toBe(before);
    expect(f.deliveries.map((r) => r.state)).toEqual([
      "PENDING",
      "PENDING",
      "PENDING"
    ]);
  });
  it("100 workers SKIP LOCKED -> 1 send/accept; no lost or duplicate record", async () => {
    await pushFixture(d.db);
    const transport = new DurableFakePushTransport(d.pool),
      send = vi.spyOn(transport, "send"),
      started = performance.now();
    const results = await Promise.all(
      Array.from({ length: 100 }, () => worker(transport).runOnce())
    );
    expect(results.filter((r) => r === "PROVIDER_ACCEPTED")).toHaveLength(1);
    expect(results.filter((r) => r === "IDLE")).toHaveLength(99);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      await d.db.notificationDelivery.count({
        where: { state: "PROVIDER_ACCEPTED", attemptCount: 1 }
      })
    ).toBe(1);
    expect(
      (
        await d.pool.query<{ count: string }>(
          "SELECT count(*) FROM push_worker_fake_receipts"
        )
      ).rows[0]!.count
    ).toBe("1");
    console.info(
      `PR07b 100 workers: ${Math.round(performance.now() - started)}ms, sends=1 accepted records=1`
    );
  });
  it("a delivery cannot use another principal's target even inside the same Team", async () => {
    const f = await pushFixture(d.db, 1, 1);
    const ownerDelivery = f.deliveries.find(
      (row) => row.outboxId === f.ownerJob.id
    )!;
    await d.db.notificationDelivery.update({
      where: { id: ownerDelivery.id },
      data: { targetKey: f.targets[1]!.targetKey }
    });
    const transport = new FakePushTransport(),
      send = vi.spyOn(transport, "send");
    const w = worker(transport),
      results = [await w.runOnce(), await w.runOnce()];
    expect(results.sort()).toEqual(["CANCELLED", "PROVIDER_ACCEPTED"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].recipientId).toBe(f.memberJob.recipientId);
  });
  it.each(["HTTP_429", "HTTP_5XX", "FAKE_TRANSIENT"])(
    "%s -> provider-aware RETRY_WAIT and exponential backoff",
    async (code) => {
      const f = await pushFixture(d.db),
        delivery = f.deliveries[0]!;
      const w = worker({
        mode: "fake",
        send: async () => ({ kind: "RETRY", code, retryAfterMs: 3000 })
      });
      for (let i = 1; i <= 3; i++) {
        const start = (
          await d.pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")
        ).rows[0]!.now;
        expect(await w.runOnce()).toBe("RETRY_WAIT");
        const row = await d.db.notificationDelivery.findUniqueOrThrow({
          where: { id: delivery.id }
        });
        expect(row).toMatchObject({
          attemptCount: i,
          lastErrorCode: code,
          acceptedAt: null,
          apnsRequestId: null,
          leaseToken: null
        });
        expect(
          row.nextAttemptAt.getTime() - start.getTime()
        ).toBeGreaterThanOrEqual(Math.max(1000 * 2 ** (i - 1), 3000) - 2);
        expect(await w.runOnce()).toBe("IDLE");
        // Synthetic schedule adjustment, only in this newly-created isolated test DB.
        await d.db.notificationDelivery.update({
          where: { id: delivery.id },
          data: { nextAttemptAt: new Date(0) }
        });
      }
      expect(await worker().runOnce()).toBe("PROVIDER_ACCEPTED");
    }
  );
  it("permanent failure is terminal; retries have an explicit bound", async () => {
    await pushFixture(d.db);
    const send = vi.fn(async (): Promise<PushTransportResult> => ({
      kind: "PERMANENT",
      code: "FAKE_PERMANENT"
    }));
    const w = worker({ mode: "fake", send });
    expect(await w.runOnce()).toBe("PERMANENT_FAILURE");
    expect(await w.runOnce()).toBe("IDLE");
    expect(send).toHaveBeenCalledTimes(1);
    const f = await pushFixture(d.db);
    expect(
      await worker(
        {
          mode: "fake",
          send: async () => ({
            kind: "RETRY",
            code: "HTTP_5XX",
            retryAfterMs: 0
          })
        },
        { maximumAttempts: 1 }
      ).runOnce()
    ).toBe("PERMANENT_FAILURE");
    expect(
      await d.db.notificationDelivery.findUnique({
        where: { id: f.deliveries[0]!.id }
      })
    ).toMatchObject({ lastErrorCode: "RETRY_EXHAUSTED", attemptCount: 1 });
  });
  it("410 revokes only the sent version; delivery finish and revocation commit together", async () => {
    const f = await pushFixture(d.db),
      target = f.targets[0]!;
    expect(
      await worker({
        mode: "fake",
        send: async () => ({ kind: "PERMANENT", code: "HTTP_410" })
      }).runOnce()
    ).toBe("PERMANENT_FAILURE");
    const row = await d.db.devicePushRegistration.findUniqueOrThrow({
      where: { targetKey: target.targetKey }
    });
    expect(row.status).toBe("REVOKED");
    expect(row.tokenVersion).toBe(target.tokenVersion + 1);
    expect(row.encryptedToken === null && row.tokenHash === null).toBe(true);
    expect(
      await d.db.notificationDelivery.findUnique({
        where: { id: f.deliveries[0]!.id }
      })
    ).toMatchObject({
      state: "PERMANENT_FAILURE",
      lastErrorCode: "HTTP_410",
      targetVersion: 1
    });
  });
  it("rotation during send: late 410 cannot revoke a newer registration", async () => {
    const f = await pushFixture(d.db),
      target = f.targets[0]!;
    const w = worker({
      mode: "fake",
      send: async () => {
        await registry(d.db).rotate(
          f.ownerScope,
          target.targetKey,
          1,
          makeDeviceToken()
        );
        return { kind: "PERMANENT", code: "HTTP_410" };
      }
    });
    expect(await w.runOnce()).toBe("PERMANENT_FAILURE");
    expect(
      await registry(d.db).get(f.ownerScope, target.targetKey)
    ).toMatchObject({ status: "ACTIVE", tokenVersion: 2 });
    expect(
      (
        await d.db.devicePushRegistration.findUniqueOrThrow({
          where: { targetKey: target.targetKey }
        })
      ).encryptedToken !== null
    ).toBe(true);
  });
  it.each(["rotated", "revoked", "member-disabled", "team-disabled"])(
    "%s before send cancels without transport call",
    async (kind) => {
      const member = kind === "member-disabled";
      const f = await pushFixture(d.db, member ? 0 : 1, member ? 1 : 0),
        target = f.targets[0]!;
      if (kind === "rotated")
        await registry(d.db).rotate(
          f.ownerScope,
          target.targetKey,
          1,
          makeDeviceToken()
        );
      if (kind === "revoked")
        await registry(d.db).revoke(f.ownerScope, target.targetKey, 1);
      if (member)
        await d.db.notificationMember.update({
          where: { id: f.member.id },
          data: { status: "DISABLED" }
        });
      if (kind === "team-disabled")
        await d.db.team.update({
          where: { id: f.team.id },
          data: { status: "SUSPENDED" }
        });
      const send = vi.fn();
      expect(await worker({ mode: "fake", send }).runOnce()).toBe("CANCELLED");
      expect(send).not.toHaveBeenCalled();
    }
  );
  it("expiry/reclaim advances generation; stale accept and stale 410 cannot update anything", async () => {
    const f = await pushFixture(d.db),
      q = new PrismaPushDeliveryQueue(d.db),
      old = (await q.claimOne(100))!;
    await new Promise((resolve) => setTimeout(resolve, 140));
    const next = (await q.claimOne(45_000))!;
    expect(next.leaseGeneration).toBe(old.leaseGeneration + 1n);
    expect(await q.finish(old, accepted)).toBe(false);
    expect(
      await q.finish(old, { state: "PERMANENT_FAILURE", code: "HTTP_410" })
    ).toBe(false);
    expect(
      await registry(d.db).get(f.ownerScope, f.targets[0]!.targetKey)
    ).toMatchObject({ status: "ACTIVE", tokenVersion: 1 });
    expect(await q.finish(next, accepted)).toBe(true);
    expect(await q.finish(next, accepted)).toBe(false);
    expect(
      await d.db.notificationDelivery.count({
        where: { state: "PROVIDER_ACCEPTED", attemptCount: 2 }
      })
    ).toBe(1);
  });
  it("410 target-lock wait crossing expiry cannot revoke or finish", async () => {
    const f = await pushFixture(d.db),
      q = new PrismaPushDeliveryQueue(d.db),
      blocker = await d.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        'SELECT "targetKey" FROM device_push_registrations WHERE "targetKey"=$1 FOR UPDATE',
        [f.targets[0]!.targetKey]
      );
      const claim = (await q.claimOne(100))!;
      const finish = q.finish(claim, {
        state: "PERMANENT_FAILURE",
        code: "HTTP_410"
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await blocker.query("COMMIT");
      expect(await finish).toBe(false);
      expect(
        await registry(d.db).get(f.ownerScope, f.targets[0]!.targetKey)
      ).toMatchObject({ status: "ACTIVE", tokenVersion: 1 });
      expect(
        await d.db.notificationDelivery.count({ where: { state: "IN_FLIGHT" } })
      ).toBe(1);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });
  it("410 persistence failure rolls back revocation and delivery together", async () => {
    const f = await pushFixture(d.db),
      claim = (await new PrismaPushDeliveryQueue(d.db).claimOne(45_000))!;
    const observed = deliveryTxProbe(d.db, {
      before: async (tx) => {
        expect(
          (
            await tx.devicePushRegistration.findUniqueOrThrow({
              where: { targetKey: f.targets[0]!.targetKey },
              select: { status: true }
            })
          ).status
        ).toBe("REVOKED");
        throw new Error("synthetic rollback");
      }
    });
    await expect(
      new PrismaPushDeliveryQueue(observed).finish(claim, {
        state: "PERMANENT_FAILURE",
        code: "HTTP_410"
      })
    ).rejects.toThrow("PUSH_DELIVERY_DATABASE_ERROR");
    expect(
      await registry(d.db).get(f.ownerScope, f.targets[0]!.targetKey)
    ).toMatchObject({ status: "ACTIVE", tokenVersion: 1 });
    expect(
      await d.db.notificationDelivery.count({ where: { state: "IN_FLIGHT" } })
    ).toBe(1);
  });
  it("transport is outside TX: independent NOWAIT lock succeeds; DB retry never re-sends", async () => {
    await pushFixture(d.db);
    let finishes = 0;
    const observed = deliveryTxProbe(d.db, {
      before: async () => {
        if (finishes++ === 0)
          throw Object.assign(new Error("synthetic serialization retry"), {
            code: "40001"
          });
      }
    });
    const send = vi.fn(
      async (input: PushTransportInput, signal: AbortSignal) => {
        const c = await d.pool.connect();
        try {
          await c.query("BEGIN");
          await c.query(
            "SELECT id FROM notification_deliveries WHERE id=$1 FOR UPDATE NOWAIT",
            [input.deliveryId]
          );
          await c.query("ROLLBACK");
        } finally {
          c.release();
        }
        return new FakePushTransport().send(input, signal);
      }
    ) satisfies PushTransport["send"];
    expect(
      await new PushDeliveryWorker(
        new PrismaPushDeliveryQueue(observed),
        { mode: "fake", send },
        { mode: "shadow" }
      ).runOnce()
    ).toBe("PROVIDER_ACCEPTED");
    expect(finishes).toBe(2);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("timeout/late success cannot finish current or newer lease", async () => {
    const f = await pushFixture(d.db);
    let late: ((v: PushTransportResult) => void) | undefined;
    expect(
      await worker(
        {
          mode: "fake",
          send: () =>
            new Promise((resolve) => {
              late = resolve;
            })
        },
        { timeoutMs: 15 }
      ).runOnce()
    ).toBe("RETRY_WAIT");
    expect(
      await d.db.notificationDelivery.findUnique({
        where: { id: f.deliveries[0]!.id }
      })
    ).toMatchObject({ lastErrorCode: "TRANSPORT_TIMEOUT", acceptedAt: null });
    late?.({ kind: "ACCEPTED", providerRequestId: randomUUID() });
    await Promise.resolve();
    expect(
      await d.db.notificationDelivery.count({
        where: { state: "PROVIDER_ACCEPTED" }
      })
    ).toBe(0);
  });
  it("abort after Fake send leaves recoverable lease, not false acceptance", async () => {
    await pushFixture(d.db);
    const stop = new AbortController();
    expect(
      await worker({
        mode: "fake",
        send: async (input, signal) => {
          const result = await new FakePushTransport().send(input, signal);
          stop.abort();
          return result;
        }
      }).runOnce(stop.signal)
    ).toBe("STOPPED");
    expect(
      await d.db.notificationDelivery.count({
        where: { state: "IN_FLIGHT", acceptedAt: null }
      })
    ).toBe(1);
  });
  it("real SIGKILL after durable Fake acceptance: lease recovery repeats send but 1 logical receipt/accepted row", async () => {
    const f = await pushFixture(d.db);
    const child = fork(
      fileURLToPath(
        new URL("./fixtures/push-worker-crash-child.ts", import.meta.url)
      ),
      [],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, DATABASE_URL: d.url }
      }
    );
    const exited = once(child, "exit");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const message = await new Promise<unknown>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("PR07B_CHECKPOINT_TIMEOUT")),
          12000
        );
        child.once("message", resolve);
        child.once("exit", () => reject(new Error("PR07B_EARLY_EXIT")));
      });
      clearTimeout(timer);
      expect(message).toEqual({
        checkpoint: "after-fake-accept-before-finish",
        id: f.deliveries[0]!.id
      });
      expect(
        (
          await d.pool.query<{ count: string }>(
            "SELECT count(*) FROM push_worker_fake_receipts"
          )
        ).rows[0]!.count
      ).toBe("1");
      expect(
        await d.db.notificationDelivery.count({
          where: { state: "IN_FLIGHT", acceptedAt: null }
        })
      ).toBe(1);
      expect(child.kill("SIGKILL")).toBe(true);
      expect((await exited)[1]).toBe("SIGKILL");
      await vi.waitFor(
        async () => {
          expect(
            (
              await d.pool.query<{ expired: boolean }>(
                'SELECT "leaseUntil"<clock_timestamp() AS expired FROM notification_deliveries WHERE id=$1',
                [f.deliveries[0]!.id]
              )
            ).rows[0]!.expired
          ).toBe(true);
        },
        { timeout: 4000, interval: 25 }
      );
      const w = worker(new DurableFakePushTransport(d.pool));
      expect(await w.runOnce()).toBe("PROVIDER_ACCEPTED");
      expect(await w.runOnce()).toBe("IDLE");
      const receipts = (
        await d.pool.query<{ providerRequestId: string; sendCalls: number }>(
          'SELECT "providerRequestId","sendCalls" FROM push_worker_fake_receipts'
        )
      ).rows;
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.sendCalls).toBe(2);
      expect(
        await d.db.notificationDelivery.findUnique({
          where: { id: f.deliveries[0]!.id }
        })
      ).toMatchObject({
        state: "PROVIDER_ACCEPTED",
        attemptCount: 2,
        leaseGeneration: 2n,
        apnsRequestId: receipts[0]!.providerRequestId
      });
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
  }, 20000);
  it("off factory untouched; 03a Fake counts/states preserved; WAITING_CONFIGURATION unclaimed", async () => {
    await deliveryFixture(d.db);
    const dependencies = vi.fn();
    expect(createPushDeliveryWorker("off", dependencies)).toBeUndefined();
    expect(dependencies).not.toHaveBeenCalled();
    const before = await oldDeliverySnapshot(d.pool);
    expect(
      await new PushDeliveryWorker(
        new PrismaPushDeliveryQueue(d.db),
        new FakePushTransport()
      ).runOnce()
    ).toBe("OFF");
    expect(await oldDeliverySnapshot(d.pool)).toBe(before);
    const fake = new FakeTransport(),
      send = vi.spyOn(fake, "send"),
      legacy = new OutboxDispatcher(new PrismaOutboxQueue(d.db), fake, {
        mode: "fake"
      });
    expect(await legacy.runOnce()).toBe("DISPATCHED");
    expect(await legacy.runOnce()).toBe("DISPATCHED");
    expect(send).toHaveBeenCalledTimes(2);
    expect(await d.db.notificationDelivery.count()).toBe(0);
    const f = await pushFixture(d.db);
    const pendingBefore = await d.db.notificationDelivery.findMany();
    expect(
      await new PushDeliveryWorker(
        new PrismaPushDeliveryQueue(d.db),
        new FakePushTransport()
      ).runOnce()
    ).toBe("OFF");
    expect(await d.db.notificationDelivery.findMany()).toEqual(pendingBefore);
    await d.db.notificationDelivery.update({
      where: { id: f.deliveries[0]!.id },
      data: { state: "WAITING_CONFIGURATION" }
    });
    expect(await worker().runOnce()).toBe("IDLE");
  });
});
