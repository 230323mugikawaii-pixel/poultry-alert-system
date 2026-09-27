import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeliveryDatabase,
  deliveryFixture,
  deliveryTxProbe
} from "./fixtures/delivery-test-database.js";
import { registry, makeDeviceToken } from "./fixtures/device-push-harness.js";
import {
  PrismaMobileDeliveryPlanner,
  type MobileConfiguration
} from "../src/modules/device-push/mobile-delivery-planner.js";
import { PrismaOutboxQueue } from "../src/modules/mail/reliability/prisma-outbox-queue.js";
import { OutboxDispatcher } from "../src/modules/mail/reliability/outbox-dispatcher.js";
import { FakeTransport } from "../src/modules/mail/reliability/outbox-transport.js";

const postgres =
  process.env.RUN_PR07A_POSTGRES_TESTS === "true" ? describe : describe.skip;
const signal = () => new AbortController().signal;
postgres("PR07a real PostgreSQL atomic mobile intents", () => {
  let d: Awaited<ReturnType<typeof createDeliveryDatabase>>;
  beforeEach(async () => {
    d = await createDeliveryDatabase();
  });
  afterEach(async () => {
    await d?.close();
  });
  const worker = (
    configuration: MobileConfiguration = "validated",
    mode: "off" | "shadow" = "shadow"
  ) => {
    const transport = new FakeTransport(),
      send = vi.spyOn(transport, "send");
    return {
      send,
      dispatcher: new OutboxDispatcher(new PrismaOutboxQueue(d.db), transport, {
        mode: "fake",
        mobileDeliveryMode: mode,
        mobilePlanner: new PrismaMobileDeliveryPlanner(d.db, configuration)
      })
    };
  };
  async function ownerOnly() {
    const f = await deliveryFixture(d.db);
    await d.db.reliabilityOutbox.update({
      where: { id: f.memberJob.id },
      data: { availableAt: new Date(Date.now() + 3600_000) }
    });
    return f;
  }
  it("one intent per ACTIVE target and current version; OWNER/MEMBER remain separate; no send/acceptance", async () => {
    const f = await deliveryFixture(d.db);
    const ownerTarget = f.targets[0]!;
    await registry(d.db).rotate(
      f.ownerScope,
      ownerTarget.targetKey,
      ownerTarget.tokenVersion,
      makeDeviceToken()
    );
    const w = worker();
    expect(await w.dispatcher.runOnce()).toBe("DISPATCHED");
    expect(await w.dispatcher.runOnce()).toBe("DISPATCHED");
    expect(await w.dispatcher.runOnce()).toBe("IDLE");
    expect(w.send).not.toHaveBeenCalled();
    const rows = await d.db.notificationDelivery.findMany();
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.outboxId === f.ownerJob.id)).toHaveLength(2);
    expect(rows.filter((r) => r.outboxId === f.memberJob.id)).toHaveLength(1);
    expect(
      rows.find((r) => r.targetKey === ownerTarget.targetKey)?.targetVersion
    ).toBe(2);
    for (const r of rows)
      expect(r).toMatchObject({
        state: "PENDING",
        attemptCount: 0,
        acceptedAt: null,
        apnsRequestId: null,
        leaseToken: null
      });
    expect(
      await d.db.reliabilityOutbox.count({ where: { status: "DISPATCHED" } })
    ).toBe(2);
  });
  it("reprocessing ON CONFLICT preserves existing delivery state; rotation gets a distinct version", async () => {
    const f = await ownerOnly(),
      w = worker();
    expect(await w.dispatcher.runOnce()).toBe("DISPATCHED");
    const row = await d.db.notificationDelivery.findFirstOrThrow();
    await d.db.notificationDelivery.update({
      where: { id: row.id },
      data: { state: "CANCELLED", attemptCount: 4 }
    });
    const requeue = () =>
      d.db.reliabilityOutbox.update({
        where: { id: f.ownerJob.id },
        data: { status: "PENDING", dispatchedAt: null }
      });
    await requeue();
    expect(await w.dispatcher.runOnce()).toBe("DISPATCHED");
    expect(await d.db.notificationDelivery.count()).toBe(2);
    expect(
      await d.db.notificationDelivery.findUnique({ where: { id: row.id } })
    ).toMatchObject({ state: "CANCELLED", attemptCount: 4 });
    await registry(d.db).rotate(
      f.ownerScope,
      row.targetKey,
      row.targetVersion,
      makeDeviceToken()
    );
    await requeue();
    expect(await w.dispatcher.runOnce()).toBe("DISPATCHED");
    expect(await d.db.notificationDelivery.count()).toBe(3);
  });
  it("missing configuration persists WAITING_CONFIGURATION + BLOCKED atomically, never accepted", async () => {
    await ownerOnly();
    const w = worker("missing");
    expect(await w.dispatcher.runOnce()).toBe("BLOCKED");
    const rows = await d.db.notificationDelivery.findMany();
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(row).toMatchObject({
        state: "WAITING_CONFIGURATION",
        lastErrorCode: "MOBILE_CONFIGURATION_MISSING",
        acceptedAt: null
      });
    expect(
      await d.db.reliabilityOutbox.count({
        where: {
          status: "BLOCKED",
          lastErrorCode: "MOBILE_CONFIGURATION_MISSING",
          dispatchedAt: null
        }
      })
    ).toBe(1);
    expect(w.send).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "no ACTIVE targets (revoked=%s): blocked, no invented target/acceptance",
    async (revoked) => {
      const f = await deliveryFixture(d.db, revoked ? 1 : 0, 0);
      if (revoked)
        await registry(d.db).revoke(
          f.ownerScope,
          f.targets[0]!.targetKey,
          f.targets[0]!.tokenVersion
        );
      const w = worker();
      expect(await w.dispatcher.runOnce()).toBe("BLOCKED");
      expect(await w.dispatcher.runOnce()).toBe("BLOCKED");
      expect(await d.db.notificationDelivery.count()).toBe(0);
      expect(
        await d.db.reliabilityOutbox.count({
          where: { status: "BLOCKED", lastErrorCode: "MOBILE_NO_ACTIVE_TARGET" }
        })
      ).toBe(2);
      expect(w.send).not.toHaveBeenCalled();
    }
  );
  it.each(["team", "subscription", "owner", "member"] as const)(
    "rechecks live %s before planning; existing recipients/history preserved",
    async (kind) => {
      const f = await deliveryFixture(d.db);
      const before = await d.db.alertRecipient.findMany({
        orderBy: { id: "asc" }
      });
      if (kind === "team")
        await d.db.team.update({
          where: { id: f.team.id },
          data: { status: "SUSPENDED" }
        });
      if (kind === "subscription")
        await d.db.subscription.updateMany({
          where: { teamId: f.team.id },
          data: { status: "CANCELED" }
        });
      if (kind === "owner")
        await d.db.user.update({
          where: { id: f.owner.id },
          data: { deletedAt: new Date() }
        });
      if (kind === "member")
        await d.db.notificationMember.update({
          where: { id: f.member.id },
          data: { status: "DISABLED" }
        });
      const w = worker();
      await w.dispatcher.runOnce();
      await w.dispatcher.runOnce();
      expect(await d.db.notificationDelivery.count()).toBe(
        kind === "owner" ? 1 : kind === "member" ? 2 : 0
      );
      expect(
        await d.db.alertRecipient.findMany({ orderBy: { id: "asc" } })
      ).toEqual(before);
      expect(w.send).not.toHaveBeenCalled();
    }
  );
  it("different Team targets cannot leak into a recipient's intents", async () => {
    const f = await ownerOnly();
    const other = await deliveryFixture(d.db, 3, 2);
    await d.db.reliabilityOutbox.updateMany({
      where: { teamId: other.team.id },
      data: { availableAt: new Date(Date.now() + 3600_000) }
    });
    expect(await worker().dispatcher.runOnce()).toBe("DISPATCHED");
    const rows = await d.db.notificationDelivery.findMany();
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (r) =>
          r.outboxId === f.ownerJob.id &&
          f.targets.some((t) => t.targetKey === r.targetKey)
      )
    ).toBe(true);
  });
  it("100 workers use SKIP LOCKED: exactly one planner, no duplicate delivery", async () => {
    await ownerOnly();
    const w = worker();
    const started = performance.now();
    const results = await Promise.all(
      Array.from({ length: 100 }, () => w.dispatcher.runOnce())
    );
    expect(results.filter((r) => r === "DISPATCHED")).toHaveLength(1);
    expect(results.filter((r) => r === "IDLE")).toHaveLength(99);
    expect(await d.db.notificationDelivery.count()).toBe(2);
    expect(w.send).not.toHaveBeenCalled();
    console.info(
      `PR07a 100 workers: ${Math.round(performance.now() - started)}ms, dispatched=1 deliveries=2 fake sends=0`
    );
  });
  it("100 concurrent attempts with same claim: fenced and idempotent", async () => {
    await ownerOnly();
    const claim = (await new PrismaOutboxQueue(d.db).claimOne(45_000))!;
    const planner = new PrismaMobileDeliveryPlanner(d.db, "validated");
    const results = await Promise.all(
      Array.from({ length: 100 }, () => planner.plan(claim, signal()))
    );
    expect(results.filter((r) => r === "DISPATCHED")).toHaveLength(1);
    expect(results.filter((r) => r === "LEASE_LOST")).toHaveLength(99);
    expect(await d.db.notificationDelivery.count()).toBe(2);
  });
  it("expired claim can be reclaimed; old generation cannot create or finish deliveries", async () => {
    await ownerOnly();
    const q = new PrismaOutboxQueue(d.db),
      old = (await q.claimOne(100))!;
    await new Promise((resolve) => setTimeout(resolve, 130));
    const next = (await q.claimOne(45_000))!;
    expect(next.leaseGeneration).toBe(old.leaseGeneration + 1n);
    const planner = new PrismaMobileDeliveryPlanner(d.db, "validated");
    expect(await planner.plan(old, signal())).toBe("LEASE_LOST");
    expect(await d.db.notificationDelivery.count()).toBe(0);
    expect(await planner.plan(next, signal())).toBe("DISPATCHED");
    expect(await d.db.notificationDelivery.count()).toBe(2);
  });
  it("lease expires while target lock is held: no orphan insert or parent dispatch", async () => {
    const f = await ownerOnly();
    const blocker = await d.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        'SELECT "targetKey" FROM device_push_registrations WHERE "teamId"=$1 FOR UPDATE',
        [f.team.id]
      );
      const claim = (await new PrismaOutboxQueue(d.db).claimOne(100))!;
      const pending = new PrismaMobileDeliveryPlanner(d.db, "validated").plan(
        claim,
        signal()
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      await blocker.query("COMMIT");
      expect(await pending).toBe("LEASE_LOST");
      expect(await d.db.notificationDelivery.count()).toBe(0);
      expect(
        await d.db.reliabilityOutbox.count({ where: { status: "DISPATCHED" } })
      ).toBe(0);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });
  it("rollback after both writes hides all intents and parent transition", async () => {
    await ownerOnly();
    const claim = (await new PrismaOutboxQueue(d.db).claimOne(45_000))!;
    const observed = deliveryTxProbe(d.db, {
      before: async (tx) => {
        expect(await tx.notificationDelivery.count()).toBe(2);
        expect(
          await tx.reliabilityOutbox.count({ where: { status: "DISPATCHED" } })
        ).toBe(1);
        throw new Error("synthetic rollback");
      }
    });
    await expect(
      new PrismaMobileDeliveryPlanner(observed, "validated").plan(
        claim,
        signal()
      )
    ).rejects.toThrow("MOBILE_INTENT_DATABASE_ERROR");
    expect(await d.db.notificationDelivery.count()).toBe(0);
    expect(
      await d.db.reliabilityOutbox.count({ where: { status: "DISPATCHED" } })
    ).toBe(0);
  });
  it.each(["before-commit", "after-commit"])(
    "real SIGKILL %s: atomic persistence and safe recovery",
    async (phase) => {
      const f = await ownerOnly();
      const child = fork(
        fileURLToPath(
          new URL("./fixtures/delivery-crash-child.ts", import.meta.url)
        ),
        [],
        {
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: { ...process.env, DATABASE_URL: d.url, PR07A_CRASH_PHASE: phase }
        }
      );
      const exited = once(child, "exit");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const checkpoint = await new Promise<unknown>((resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("PR07A_CHECKPOINT_TIMEOUT")),
            12_000
          );
          child.once("message", resolve);
          child.once("exit", () => reject(new Error("PR07A_EARLY_EXIT")));
        });
        clearTimeout(timer);
        expect(checkpoint).toEqual({
          checkpoint: phase,
          id: f.ownerJob.id,
          count: 2
        });
        expect(await d.db.notificationDelivery.count()).toBe(
          phase === "before-commit" ? 0 : 2
        );
        expect(
          await d.db.reliabilityOutbox.count({
            where: { status: "DISPATCHED" }
          })
        ).toBe(phase === "before-commit" ? 0 : 1);
        expect(child.kill("SIGKILL")).toBe(true);
        expect((await exited)[1]).toBe("SIGKILL");
        if (phase === "before-commit") {
          await vi.waitFor(
            async () => {
              const rows = await d.db.$queryRaw<
                { expired: boolean }[]
              >`SELECT "leaseUntil"<clock_timestamp() AS expired FROM reliability_outbox WHERE id=${f.ownerJob.id}::uuid`;
              expect(rows[0]?.expired).toBe(true);
            },
            { timeout: 4000, interval: 25 }
          );
        }
        expect(await worker().dispatcher.runOnce()).toBe(
          phase === "before-commit" ? "DISPATCHED" : "IDLE"
        );
        expect(await d.db.notificationDelivery.count()).toBe(2);
        expect(
          await d.db.reliabilityOutbox.count({
            where: { status: "DISPATCHED" }
          })
        ).toBe(1);
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
      }
    },
    20_000
  );
  it("mobile mode off preserves 03a Fake path and does not create intents", async () => {
    await deliveryFixture(d.db);
    const w = worker("validated", "off");
    expect(await w.dispatcher.runOnce()).toBe("DISPATCHED");
    expect(await w.dispatcher.runOnce()).toBe("DISPATCHED");
    expect(await w.dispatcher.runOnce()).toBe("IDLE");
    expect(w.send).toHaveBeenCalledTimes(2);
    expect(await d.db.notificationDelivery.count()).toBe(0);
    expect(
      await d.db.reliabilityOutbox.count({
        where: { status: "DISPATCHED", attempts: 1 }
      })
    ).toBe(2);
  });
});
