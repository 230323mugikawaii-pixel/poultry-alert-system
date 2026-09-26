import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevicePushRegistry } from "../src/modules/device-push/device-push-registry.js";
import type { EncryptedToken } from "../src/modules/mail/token-encryption.js";
import {
  createDeviceTestDatabase,
  oldTablesSnapshot
} from "./fixtures/device-test-database.js";
import {
  deviceApp,
  deviceEnvironment,
  deviceFixture,
  encryption,
  makeDeviceToken,
  registry
} from "./fixtures/device-push-harness.js";

const postgres =
  process.env.RUN_PR06_POSTGRES_TESTS === "true" ? describe : describe.skip;
postgres("PR06 authenticated device registry (real PostgreSQL)", () => {
  let test: Awaited<ReturnType<typeof createDeviceTestDatabase>>;
  beforeAll(async () => {
    test = await createDeviceTestDatabase();
  }, 60000);
  afterAll(async () => {
    await test?.close();
  });

  for (const kind of ["owner", "member"] as const) {
    it(`${kind}: real session register/re-register/rotate/read/revoke/reactivate; stable target, old versions fenced`, async () => {
      const f = await deviceFixture(test.db),
        app = await deviceApp(test.db);
      const path = f[`${kind}Path`],
        headers = f[`${kind}Headers`],
        token = makeDeviceToken(),
        installationId = randomUUID();
      try {
        const created = await app.inject({
          method: "POST",
          url: path,
          headers,
          payload: { installationId, platform: "APNS", deviceToken: token }
        });
        expect(created.statusCode).toBe(201);
        const first = created.json<{
          targetKey: string;
          tokenVersion: number;
          createdAt: string;
        }>();
        expect(first.tokenVersion).toBe(1);
        expect(created.headers["cache-control"]).toBe("no-store");
        expect(created.body.includes(token)).toBe(false);
        const stored = await test.db.devicePushRegistration.findUniqueOrThrow({
          where: { targetKey: first.targetKey }
        });
        expect(stored.principalKind).toBe(
          kind === "owner" ? "OWNER" : "MEMBER"
        );
        expect(stored.principalId).toBe(
          kind === "owner" ? f.owner.id : f.member.id
        );
        expect(stored.ownerUserId).toBe(kind === "owner" ? f.owner.id : null);
        expect(stored.notificationMemberId).toBe(
          kind === "member" ? f.member.id : null
        );
        expect(stored.encryptedToken?.includes(token)).toBe(false);
        expect(
          (await encryption.decrypt(
            JSON.parse(stored.encryptedToken!) as EncryptedToken
          )) === token
        ).toBe(true);
        const again = await app.inject({
          method: "POST",
          url: path,
          headers,
          payload: {
            installationId,
            platform: "APNS",
            deviceToken: token.toUpperCase()
          }
        });
        expect(again.statusCode).toBe(201);
        expect(again.json()).toMatchObject({
          targetKey: first.targetKey,
          createdAt: first.createdAt,
          tokenVersion: 2
        });
        expect(
          await test.db.devicePushRegistration.count({
            where: { targetKey: first.targetKey }
          })
        ).toBe(1);
        const url = `${path}/${first.targetKey}`;
        const rotated = await app.inject({
          method: "PUT",
          url,
          headers,
          payload: { tokenVersion: 2, deviceToken: makeDeviceToken() }
        });
        expect(rotated.statusCode).toBe(200);
        expect(rotated.json()).toMatchObject({
          targetKey: first.targetKey,
          tokenVersion: 3,
          status: "ACTIVE"
        });
        expect(
          (
            await app.inject({
              method: "PUT",
              url,
              headers,
              payload: { tokenVersion: 2, deviceToken: token }
            })
          ).statusCode
        ).toBe(409);
        expect(
          (
            await app.inject({
              method: "DELETE",
              url,
              headers,
              payload: { tokenVersion: 2 }
            })
          ).statusCode
        ).toBe(409);
        const read = await app.inject({ method: "GET", url, headers });
        expect(read.statusCode).toBe(200);
        expect(Object.keys(read.json()).sort()).toEqual(
          [
            "targetKey",
            "installationId",
            "platform",
            "tokenVersion",
            "status",
            "createdAt",
            "lastSeenAt",
            "rotatedAt"
          ].sort()
        );
        const removed = await app.inject({
          method: "DELETE",
          url,
          headers,
          payload: { tokenVersion: 3 }
        });
        expect(removed.statusCode).toBe(200);
        expect(removed.json()).toMatchObject({
          status: "REVOKED",
          tokenVersion: 4
        });
        expect(
          (
            await app.inject({
              method: "DELETE",
              url,
              headers,
              payload: { tokenVersion: 3 }
            })
          ).json()
        ).toMatchObject({ tokenVersion: 4 });
        const revoked = await test.db.devicePushRegistration.findUniqueOrThrow({
          where: { targetKey: first.targetKey }
        });
        expect(
          revoked.encryptedToken === null && revoked.tokenHash === null
        ).toBe(true);
        expect(
          (
            await app.inject({
              method: "PUT",
              url,
              headers,
              payload: { tokenVersion: 4, deviceToken: token }
            })
          ).statusCode
        ).toBe(409);
        const resumed = await app.inject({
          method: "POST",
          url: path,
          headers,
          payload: {
            installationId,
            platform: "APNS",
            deviceToken: makeDeviceToken()
          }
        });
        expect(resumed.json()).toMatchObject({
          targetKey: first.targetKey,
          tokenVersion: 5,
          status: "ACTIVE"
        });
      } finally {
        await app.close();
      }
    });
  }

  it("cross principal / team / OWNER vs MEMBER reads and writes return 404 without mutation", async () => {
    const a = await deviceFixture(test.db),
      b = await deviceFixture(test.db),
      app = await deviceApp(test.db),
      service = registry(test.db);
    const ownerTarget = await service.register(
      a.ownerScope,
      randomUUID(),
      makeDeviceToken()
    );
    const memberTarget = await service.register(
      a.memberScope,
      randomUUID(),
      makeDeviceToken()
    );
    const before = await test.db.devicePushRegistration.findMany({
      orderBy: { targetKey: "asc" }
    });
    try {
      for (const [path, headers, target] of [
        [b.ownerPath, b.ownerHeaders, ownerTarget],
        [b.memberPath, b.memberHeaders, memberTarget],
        [a.ownerPath, a.ownerHeaders, memberTarget],
        [a.memberPath, a.memberHeaders, ownerTarget]
      ] as const) {
        const url = `${path}/${target.targetKey}`;
        for (const request of [
          { method: "GET" as const },
          {
            method: "PUT" as const,
            payload: { tokenVersion: 1, deviceToken: makeDeviceToken() }
          },
          { method: "DELETE" as const, payload: { tokenVersion: 1 } }
        ]) {
          expect(
            (await app.inject({ ...request, url, headers })).statusCode
          ).toBe(404);
        }
      }
      expect(
        (
          await app.inject({
            method: "POST",
            url: a.ownerPath,
            headers: b.ownerHeaders,
            payload: {
              installationId: randomUUID(),
              platform: "APNS",
              deviceToken: makeDeviceToken()
            }
          })
        ).statusCode
      ).toBe(404);
      expect(
        JSON.stringify(
          await test.db.devicePushRegistration.findMany({
            orderBy: { targetKey: "asc" }
          })
        ) === JSON.stringify(before)
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("same UUID in User and NotificationMember never conflates principals", async () => {
    const f = await deviceFixture(test.db);
    await test.db.notificationMember.create({
      data: {
        id: f.owner.id,
        teamId: f.team.id,
        callNowId: `CN-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
        passwordHash: "synthetic-no-login"
      }
    });
    const service = registry(test.db),
      installationId = randomUUID();
    const owner = await service.register(
      f.ownerScope,
      installationId,
      makeDeviceToken()
    );
    const member = await service.register(
      { ...f.memberScope, principalId: f.owner.id },
      installationId,
      makeDeviceToken()
    );
    expect(owner.targetKey !== member.targetKey).toBe(true);
    await expect(
      service.get(f.ownerScope, member.targetKey)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("100 concurrent re-registrations: one target, monotonic version 100; no SELECT-then-INSERT race", async () => {
    const f = await deviceFixture(test.db),
      service = registry(test.db),
      installationId = randomUUID(),
      token = makeDeviceToken();
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        service.register(f.ownerScope, installationId, token)
      )
    );
    expect(new Set(results.map((r) => r.targetKey)).size).toBe(1);
    expect(new Set(results.map((r) => r.tokenVersion)).size).toBe(100);
    const row = await service.get(f.ownerScope, results[0]!.targetKey);
    expect(row.tokenVersion).toBe(100);
    expect(
      await test.db.devicePushRegistration.count({
        where: { ...f.ownerScope, installationId }
      })
    ).toBe(1);
  }, 30000);

  it("simultaneous rotate/revoke with same version: one succeeds, other fenced; no resurrection", async () => {
    const f = await deviceFixture(test.db),
      s = registry(test.db),
      row = await s.register(f.memberScope, randomUUID(), makeDeviceToken());
    const results = await Promise.allSettled([
      s.rotate(f.memberScope, row.targetKey, 1, makeDeviceToken()),
      s.revoke(f.memberScope, row.targetKey, 1)
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect((await s.get(f.memberScope, row.targetKey)).tokenVersion).toBe(2);
  });

  it("a live token cannot be stolen or bound to two installations/principals; revoke releases only its binding", async () => {
    const a = await deviceFixture(test.db),
      b = await deviceFixture(test.db),
      s = registry(test.db),
      token = makeDeviceToken();
    const row = await s.register(a.ownerScope, randomUUID(), token);
    await expect(
      s.register(b.memberScope, randomUUID(), token)
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      s.register(a.ownerScope, randomUUID(), token)
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await s.get(a.ownerScope, row.targetKey)).tokenVersion).toBe(1);
    await s.revoke(a.ownerScope, row.targetKey, 1);
    expect((await s.register(b.memberScope, randomUUID(), token)).status).toBe(
      "ACTIVE"
    );
  });

  for (const kind of ["owner", "member"] as const) {
    it(`${kind}: missing/wrong cookie, revoked/expired session rejected; no table writes`, async () => {
      const f = await deviceFixture(test.db),
        app = await deviceApp(test.db),
        path = f[`${kind}Path`],
        headers = f[`${kind}Headers`];
      const payload = {
        installationId: randomUUID(),
        platform: "APNS",
        deviceToken: makeDeviceToken()
      };
      try {
        for (const bad of [
          { origin: headers.origin },
          f[kind === "owner" ? "memberHeaders" : "ownerHeaders"]
        ])
          expect(
            (
              await app.inject({
                method: "POST",
                url: path,
                headers: bad,
                payload
              })
            ).statusCode
          ).toBe(401);
        if (kind === "owner")
          await test.db.session.update({
            where: { id: f.ownerSession.id },
            data: { expiresAt: new Date(0) }
          });
        else
          await test.db.notificationMemberSession.update({
            where: { id: f.memberSession.id },
            data: { expiresAt: new Date(0) }
          });
        expect(
          (await app.inject({ method: "POST", url: path, headers, payload }))
            .statusCode
        ).toBe(401);
        if (kind === "owner")
          await test.db.session.update({
            where: { id: f.ownerSession.id },
            data: {
              expiresAt: new Date(Date.now() + 3600000),
              revokedAt: new Date()
            }
          });
        else
          await test.db.notificationMemberSession.update({
            where: { id: f.memberSession.id },
            data: {
              expiresAt: new Date(Date.now() + 3600000),
              revokedAt: new Date()
            }
          });
        expect(
          (await app.inject({ method: "POST", url: path, headers, payload }))
            .statusCode
        ).toBe(401);
        expect(
          await test.db.devicePushRegistration.count({
            where: { teamId: f.team.id }
          })
        ).toBe(0);
      } finally {
        await app.close();
      }
    });
  }

  it("disabled/deleted members, inactive Team and removed/demoted Owner fail live authorization", async () => {
    const f = await deviceFixture(test.db),
      s = registry(test.db);
    const registerMember = () =>
      s.register(f.memberScope, randomUUID(), makeDeviceToken());
    await test.db.notificationMember.update({
      where: { id: f.member.id },
      data: { status: "DISABLED" }
    });
    await expect(registerMember()).rejects.toMatchObject({ statusCode: 403 });
    await test.db.notificationMember.update({
      where: { id: f.member.id },
      data: { status: "ACTIVE", deletedAt: new Date() }
    });
    await expect(registerMember()).rejects.toMatchObject({ statusCode: 403 });
    await test.db.teamMembership.updateMany({
      where: { teamId: f.team.id, userId: f.owner.id },
      data: { role: "MEMBER" }
    });
    await expect(
      s.register(f.ownerScope, randomUUID(), makeDeviceToken())
    ).rejects.toMatchObject({ statusCode: 403 });
    await test.db.teamMembership.updateMany({
      where: { teamId: f.team.id, userId: f.owner.id },
      data: { role: "OWNER", status: "REMOVED", removedAt: new Date() }
    });
    await expect(
      s.register(f.ownerScope, randomUUID(), makeDeviceToken())
    ).rejects.toMatchObject({ statusCode: 403 });
    await test.db.teamMembership.updateMany({
      where: { teamId: f.team.id, userId: f.owner.id },
      data: { status: "ACTIVE", removedAt: null }
    });
    await test.db.team.update({
      where: { id: f.team.id },
      data: { status: "SUSPENDED" }
    });
    await expect(
      s.register(f.ownerScope, randomUUID(), makeDeviceToken())
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      s.register(
        { ...f.memberScope, teamId: randomUUID() },
        randomUUID(),
        makeDeviceToken()
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("disable committed while encryption is in flight is rechecked before persistence", async () => {
    const f = await deviceFixture(test.db);
    let entered!: () => void, resume!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const service = new DevicePushRegistry(
      test.db,
      {
        encrypt: async (value) => {
          entered();
          await gate;
          return encryption.encrypt(value);
        },
        decrypt: (value) => encryption.decrypt(value)
      },
      deviceEnvironment().AUTH_TOKEN_PEPPER
    );
    const result = service.register(
      f.memberScope,
      randomUUID(),
      makeDeviceToken()
    );
    await started;
    await test.db.notificationMember.update({
      where: { id: f.member.id },
      data: { status: "DISABLED" }
    });
    resume();
    await expect(result).rejects.toMatchObject({ statusCode: 403 });
    expect(
      await test.db.devicePushRegistration.count({
        where: { teamId: f.team.id }
      })
    ).toBe(0);
  });

  it("origin required for all mutations; bad input cannot assign principal or reveal raw token", async () => {
    const f = await deviceFixture(test.db),
      app = await deviceApp(test.db),
      s = registry(test.db);
    const token = makeDeviceToken(),
      payload = {
        installationId: randomUUID(),
        platform: "APNS",
        deviceToken: token
      };
    const row = await s.register(f.ownerScope, randomUUID(), makeDeviceToken());
    try {
      for (const origin of [undefined, "https://untrusted.invalid"]) {
        const headers = {
          cookie: f.ownerHeaders.cookie,
          ...(origin ? { origin } : {})
        };
        for (const req of [
          { method: "POST" as const, url: f.ownerPath, payload },
          {
            method: "PUT" as const,
            url: `${f.ownerPath}/${row.targetKey}`,
            payload: { tokenVersion: 1, deviceToken: token }
          },
          {
            method: "DELETE" as const,
            url: `${f.ownerPath}/${row.targetKey}`,
            payload: { tokenVersion: 1 }
          }
        ])
          expect((await app.inject({ ...req, headers })).statusCode).toBe(403);
      }
      for (const bad of [
        { ...payload, principalId: f.member.id },
        { ...payload, deviceToken: `${token}!` },
        { ...payload, platform: "WEB_PUSH" },
        { ...payload, deviceToken: "ab".repeat(513) }
      ]) {
        const r = await app.inject({
          method: "POST",
          url: f.ownerPath,
          headers: f.ownerHeaders,
          payload: bad
        });
        expect(r.statusCode).toBe(400);
        expect(r.body.includes(token)).toBe(false);
      }
      const malformed = await app.inject({
        method: "POST",
        url: f.ownerPath,
        headers: { ...f.ownerHeaders, "content-type": "application/json" },
        payload: `{"deviceToken":"${token}"`
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.body.includes(token)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("encryption failure is sanitized and atomic; encryption happens outside DB transaction", async () => {
    const f = await deviceFixture(test.db),
      token = makeDeviceToken();
    const s = new DevicePushRegistry(
      test.db,
      {
        encrypt: async () => {
          throw new Error(token);
        },
        decrypt: async () => ""
      },
      deviceEnvironment().AUTH_TOKEN_PEPPER
    );
    await expect(
      s.register(f.ownerScope, randomUUID(), token)
    ).rejects.toMatchObject({
      code: "PUSH_REGISTRY_UNAVAILABLE",
      statusCode: 503
    });
    expect(
      await test.db.devicePushRegistration.count({
        where: { teamId: f.team.id }
      })
    ).toBe(0);
    let unlocked = false;
    const checked = new DevicePushRegistry(
      test.db,
      {
        ...encryption,
        encrypt: async (value) => {
          const session = await test.pool.connect();
          try {
            await session.query("BEGIN");
            await session.query(
              "SELECT id FROM teams WHERE id=$1 FOR UPDATE NOWAIT",
              [f.team.id]
            );
            unlocked = true;
          } finally {
            await session.query("ROLLBACK");
            session.release();
          }
          return encryption.encrypt(value);
        },
        decrypt: (value) => encryption.decrypt(value)
      },
      deviceEnvironment().AUTH_TOKEN_PEPPER
    );
    await checked.register(f.ownerScope, randomUUID(), token);
    expect(unlocked).toBe(true);
  });

  it("registry operations change no existing data or schema; no plaintext in database", async () => {
    const f = await deviceFixture(test.db),
      before = await oldTablesSnapshot(test.pool),
      s = registry(test.db),
      token = makeDeviceToken();
    const row = await s.register(f.ownerScope, randomUUID(), token);
    await s.rotate(f.ownerScope, row.targetKey, 1, makeDeviceToken());
    await s.revoke(f.ownerScope, row.targetKey, 2);
    await s.register(f.memberScope, randomUUID(), token);
    expect(await oldTablesSnapshot(test.pool)).toBe(before);
    const dump = JSON.stringify(
      (
        await test.pool.query(
          "SELECT to_jsonb(t) FROM device_push_registrations t"
        )
      ).rows
    );
    expect(dump.includes(token)).toBe(false);
  });

  it("CHECKs/FKs reject malformed principal/version/token state without altering old tables", async () => {
    const f = await deviceFixture(test.db),
      row = await registry(test.db).register(
        f.ownerScope,
        randomUUID(),
        makeDeviceToken()
      );
    for (const sql of [
      'UPDATE device_push_registrations SET "principalKind"=\'MEMBER\' WHERE "targetKey"=$1',
      'UPDATE device_push_registrations SET "tokenVersion"=0 WHERE "targetKey"=$1',
      'UPDATE device_push_registrations SET "encryptedToken"=NULL WHERE "targetKey"=$1',
      "UPDATE device_push_registrations SET status='REVOKED' WHERE \"targetKey\"=$1"
    ])
      await expect(test.pool.query(sql, [row.targetKey])).rejects.toMatchObject(
        { code: "23514" }
      );
    expect(
      (await registry(test.db).get(f.ownerScope, row.targetKey)).tokenVersion
    ).toBe(1);
  });
});
