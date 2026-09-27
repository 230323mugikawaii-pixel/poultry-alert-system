import type { TokenEncryptionProvider } from "../src/modules/mail/token-encryption.js";
import type * as Http2 from "node:http2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPushWorkerDatabase,
  pushFixture
} from "./fixtures/push-worker-harness.js";
import {
  oldDeliverySnapshot,
  deliveryFixture
} from "./fixtures/delivery-test-database.js";
import {
  encryption,
  registry,
  makeDeviceToken
} from "./fixtures/device-push-harness.js";
import {
  apnsConfiguration,
  apnsEnvironment,
  startApnsMock
} from "./fixtures/apns-mock.js";
import { ApnsHttp2Transport } from "../src/modules/device-push/apns-http2-transport.js";
import { PrismaPushDeliveryQueue } from "../src/modules/device-push/prisma-push-delivery-queue.js";
import { PushDeliveryWorker } from "../src/modules/device-push/push-delivery-worker.js";
import { apnsPlannerConfiguration } from "../src/modules/device-push/apns-config.js";
import { PrismaMobileDeliveryPlanner } from "../src/modules/device-push/mobile-delivery-planner.js";
import { OutboxDispatcher } from "../src/modules/mail/reliability/outbox-dispatcher.js";
import { PrismaOutboxQueue } from "../src/modules/mail/reliability/prisma-outbox-queue.js";
import { FakeTransport } from "../src/modules/mail/reliability/outbox-transport.js";

vi.mock("node:http2", async (original) => {
  const m = await original<typeof Http2>();
  return {
    ...m,
    connect: (authority: string | URL, ...args: unknown[]) => {
      const url = new URL(authority);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
        throw new Error("PR07C_NON_LOOPBACK_FORBIDDEN");
      return Reflect.apply(m.connect, m, [
        authority,
        ...args
      ]) as Http2.ClientHttp2Session;
    }
  };
});
const postgres =
  process.env.RUN_PR07C_POSTGRES_TESTS === "true" ? describe : describe.skip;
postgres("PR07c real PostgreSQL + LOCAL HTTP2 only", () => {
  let d: Awaited<ReturnType<typeof createPushWorkerDatabase>>;
  const cleanups: (() => Promise<void> | void)[] = [];
  beforeEach(async () => {
    d = await createPushWorkerDatabase("pr07c");
  });
  afterEach(async () => {
    for (const close of cleanups.splice(0).reverse()) await close();
    await d?.close();
  });
  const setup = async (
    handler?: Parameters<typeof startApnsMock>[0],
    decrypt: TokenEncryptionProvider = encryption
  ) => {
    const mock = await startApnsMock(handler);
    cleanups.push(mock.close);
    const transport = ApnsHttp2Transport.forTest(
      apnsConfiguration(),
      decrypt,
      mock.connect
    );
    cleanups.push(() => transport.close());
    const queue = new PrismaPushDeliveryQueue(d.db);
    return {
      mock,
      transport,
      queue,
      worker: new PushDeliveryWorker(queue, transport, { mode: "apns" })
    };
  };
  it("OWNER/MEMBER intents accepted by mock, request IDs stored, legacy data unchanged", async () => {
    await pushFixture(d.db, 1, 1);
    const before = await oldDeliverySnapshot(d.pool);
    const { worker, mock } = await setup();
    expect(await worker.runOnce()).toBe("PROVIDER_ACCEPTED");
    expect(await worker.runOnce()).toBe("PROVIDER_ACCEPTED");
    expect(await worker.runOnce()).toBe("IDLE");
    expect(mock.connections).toBe(1);
    const rows = await d.db.notificationDelivery.findMany();
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (r) =>
          r.acceptedAt !== null &&
          mock.requests.some((q) => q.headers["apns-id"] === r.apnsRequestId)
      )
    ).toBe(true);
    expect(await oldDeliverySnapshot(d.pool)).toBe(before);
  });
  it.each([
    [410, "Unregistered", "PERMANENT_FAILURE", "REVOKED"],
    [400, "BadDeviceToken", "PERMANENT_FAILURE", "ACTIVE"],
    [400, "DeviceTokenNotForTopic", "PERMANENT_FAILURE", "ACTIVE"]
  ])(
    "status %s reason %s updates only the intended registration",
    async (status, reason, state, registrationStatus) => {
      const f = await pushFixture(d.db);
      const { worker } = await setup((s) => {
        s.respond({ ":status": Number(status) });
        s.end(JSON.stringify({ reason }));
      });
      expect(await worker.runOnce()).toBe(state);
      const row = await d.db.devicePushRegistration.findUniqueOrThrow({
        where: { targetKey: f.targets[0]!.targetKey }
      });
      expect(row.status).toBe(registrationStatus);
      expect(row.tokenVersion).toBe(status === 410 ? 2 : 1);
    }
  );
  it.each([
    [500, "InternalServerError"],
    [503, "ServiceUnavailable"]
  ])("%s => at least 15 minutes RETRY_WAIT", async (status, reason) => {
    await pushFixture(d.db);
    const { worker } = await setup((s) => {
      s.respond({ ":status": Number(status) });
      s.end(JSON.stringify({ reason }));
    });
    expect(await worker.runOnce()).toBe("RETRY_WAIT");
    const r = await d.db.notificationDelivery.findFirstOrThrow();
    const clock = await d.pool.query<{ remaining: number }>(
      `SELECT extract(epoch from ("nextAttemptAt"-clock_timestamp()))::float AS remaining FROM notification_deliveries WHERE id=$1`,
      [r.id]
    );
    expect(clock.rows[0]!.remaining).toBeGreaterThan(898);
    expect(r.lastErrorCode).toBe("HTTP_5XX");
    expect(await worker.runOnce()).toBe("IDLE");
  });
  it.each([
    [403, "InvalidProviderToken", "APNS_CONFIG"],
    [403, "Forbidden", "APNS_FORBIDDEN"],
    [413, "PayloadTooLarge", "APNS_PAYLOAD_TOO_LARGE"]
  ] as const)(
    "global %s/%s retains delivery and latches %s before any next claim",
    async (status, reason, code) => {
      await pushFixture(d.db, 2);
      const { worker, mock, queue } = await setup((s) => {
        s.respond({ ":status": status });
        s.end(JSON.stringify({ reason }));
      });
      const claim = vi.spyOn(queue, "claimOne");
      expect(await worker.runOnce()).toBe("RETRY_WAIT");
      expect(worker.haltReason).toBe(code);
      expect(await worker.runOnce()).toBe("STOPPED");
      expect(claim).toHaveBeenCalledTimes(1);
      expect(mock.requests).toHaveLength(1);
      expect(
        await d.db.notificationDelivery.count({
          where: { state: "PERMANENT_FAILURE" }
        })
      ).toBe(0);
      expect(
        await d.db.notificationDelivery.count({ where: { state: "PENDING" } })
      ).toBe(1);
    }
  );
  it("prepare captures ciphertext with matching version; decrypt-time rotation prevents old HTTP request", async () => {
    const f = await pushFixture(d.db);
    const { worker, mock } = await setup(undefined, {
      encrypt: (t) => encryption.encrypt(t),
      decrypt: async (envelope) => {
        await registry(d.db).rotate(
          f.ownerScope,
          f.targets[0]!.targetKey,
          1,
          makeDeviceToken()
        );
        return encryption.decrypt(envelope);
      }
    });
    expect(await worker.runOnce()).toBe("CANCELLED");
    expect(mock.requests).toHaveLength(0);
    expect(mock.connections).toBe(0);
    expect(
      (await d.db.devicePushRegistration.findFirstOrThrow()).tokenVersion
    ).toBe(2);
  });
  it("rotation AFTER final check can race with I/O, late 410 never revokes newer version", async () => {
    const f = await pushFixture(d.db);
    const { worker } = await setup((s) => {
      void (async () => {
        await registry(d.db).rotate(
          f.ownerScope,
          f.targets[0]!.targetKey,
          1,
          makeDeviceToken()
        );
        s.respond({ ":status": 410 });
        s.end(JSON.stringify({ reason: "Unregistered" }));
      })();
    });
    expect(await worker.runOnce()).toBe("PERMANENT_FAILURE");
    const row = await d.db.devicePushRegistration.findFirstOrThrow();
    expect(row.status).toBe("ACTIVE");
    expect(row.tokenVersion).toBe(2);
  });
  it("Fake prepare receives no ciphertext; APNs receives the exact encrypted snapshot, no plaintext DB/log", async () => {
    const f = await pushFixture(d.db);
    const token = makeDeviceToken();
    await registry(d.db).rotate(
      f.ownerScope,
      f.targets[0]!.targetKey,
      1,
      token
    );
    await d.db.notificationDelivery.updateMany({ data: { targetVersion: 2 } });
    const q = new PrismaPushDeliveryQueue(d.db),
      claim = (await q.claimOne(45000))!;
    const fake = await q.prepare(claim),
      apns = await q.prepare(claim, "apns");
    expect(
      fake && !("encryptedToken" in fake) && !("confirmCurrent" in fake)
    ).toBe(true);
    const registered = await d.db.devicePushRegistration.findFirstOrThrow();
    expect(apns?.encryptedToken === registered.encryptedToken).toBe(true);
    const before = await oldDeliverySnapshot(d.pool);
    const logs: string[] = [];
    for (const level of ["log", "info", "warn", "error"] as const)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(JSON.stringify(args));
      });
    try {
      const { transport } = await setup();
      expect(
        (await transport.send(apns!, new AbortController().signal)).kind
      ).toBe("ACCEPTED");
      expect(JSON.stringify(registered).includes(token)).toBe(false);
      expect(
        logs.join("").includes(token) ||
          logs.join("").includes(registered.encryptedToken!)
      ).toBe(false);
      expect(await oldDeliverySnapshot(d.pool)).toBe(before);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it.each([true, false])(
    "APNs dispatcher configuration valid=%s -> PENDING or WAITING_CONFIGURATION, no send",
    async (valid) => {
      const f = await deliveryFixture(d.db, 1, 0);
      const worker = new OutboxDispatcher(
        new PrismaOutboxQueue(d.db),
        new FakeTransport(),
        {
          mode: "fake",
          mobileDeliveryMode: "apns",
          mobilePlanner: new PrismaMobileDeliveryPlanner(
            d.db,
            apnsPlannerConfiguration(valid ? apnsEnvironment() : {})
          )
        }
      );
      await worker.runOnce();
      await worker.runOnce();
      const rows = await d.db.notificationDelivery.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe(valid ? "PENDING" : "WAITING_CONFIGURATION");
      const parent = await d.db.reliabilityOutbox.findUniqueOrThrow({
        where: { id: f.ownerJob.id }
      });
      expect(parent.status).toBe(valid ? "DISPATCHED" : "BLOCKED");
      expect(rows[0]!.acceptedAt).toBeNull();
    }
  );
  it("100 mock workers => one HTTP request and one accepted record", async () => {
    await pushFixture(d.db);
    const { transport, mock } = await setup();
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        new PushDeliveryWorker(new PrismaPushDeliveryQueue(d.db), transport, {
          mode: "apns"
        }).runOnce()
      )
    );
    expect(results.filter((r) => r === "PROVIDER_ACCEPTED")).toHaveLength(1);
    expect(mock.requests).toHaveLength(1);
    expect(
      await d.db.notificationDelivery.count({
        where: { state: "PROVIDER_ACCEPTED" }
      })
    ).toBe(1);
  });
});
