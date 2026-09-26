import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnvironment } from "../src/config/env.js";
import type { DatabaseClient } from "../src/db/client.js";
import {
  createDevicePushRegistry,
  DevicePushRegistry
} from "../src/modules/device-push/device-push-registry.js";
import { createDevicePushRoutes } from "../src/modules/device-push/device-push-routes.js";
import type { AuthService } from "../src/modules/auth/auth-service.js";
import type { NotificationMemberService } from "../src/modules/notification-members/notification-member-service.js";
import type { TeamService } from "../src/modules/teams/team-service.js";
import { notificationMemberCookieName } from "../src/modules/notification-members/notification-member-cookie.js";

describe("PR06 registry boundary", () => {
  it("malformed JSON and raw service failure expose neither device token nor cookie in captured logs/responses", async () => {
    const env = loadEnvironment({ APP_ENV: "test" });
    const token = randomUUID().replaceAll("-", "");
    const session =
      randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    let logs = "";
    const app = Fastify({
      logger: {
        level: "info",
        redact: [
          "req.headers.cookie",
          "req.url",
          "body.deviceToken",
          "req.body.deviceToken"
        ],
        stream: new Writable({
          write(chunk: Buffer, _encoding, done) {
            logs += chunk.toString();
            done();
          }
        })
      }
    });
    app.setValidatorCompiler(TypeBoxValidatorCompiler);
    await app.register(cookie);
    await app.register(
      createDevicePushRoutes(
        {
          register: async () => {
            throw new Error(token);
          }
        } as unknown as DevicePushRegistry,
        {} as AuthService,
        {
          authenticate: async () => ({
            team: { id: randomUUID() },
            member: { id: randomUUID() }
          })
        } as unknown as NotificationMemberService,
        {} as TeamService,
        env
      )
    );
    try {
      const request = {
        method: "POST" as const,
        url: "/api/v1/notification-members/push-devices",
        headers: {
          origin: env.PUBLIC_ORIGIN,
          cookie: `${notificationMemberCookieName(env)}=${session}`,
          "content-type": "application/json"
        }
      };
      const bad = await app.inject({
        ...request,
        payload: `{"deviceToken":"${token}"`
      });
      const failed = await app.inject({
        ...request,
        payload: {
          installationId: randomUUID(),
          platform: "APNS",
          deviceToken: token
        }
      });
      expect(bad.statusCode).toBe(400);
      expect(failed.statusCode).toBe(503);
      expect(
        [logs, bad.body, failed.body].some(
          (s) => s.includes(token) || s.includes(session)
        )
      ).toBe(false);
      expect(logs.includes("incoming request")).toBe(true);
    } finally {
      await app.close();
    }
  });
  it("default off: lazy dependencies not evaluated and routes absent", async () => {
    const environment = loadEnvironment({ APP_ENV: "test" });
    expect(environment.MOBILE_PUSH_REGISTRY_MODE).toBe("off");
    expect(
      createDevicePushRegistry("off", () => {
        throw new Error("MUST_NOT_RUN");
      })
    ).toBeUndefined();
    const app = await buildApp({
      environment,
      logger: false,
      devicePushRegistryFactory: () => {
        throw new Error("MUST_NOT_RUN");
      }
    });
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/notification-members/push-devices"
          })
        ).statusCode
      ).toBe(404);
    } finally {
      await app.close();
    }
    expect(() =>
      loadEnvironment({ MOBILE_PUSH_REGISTRY_MODE: "send" })
    ).toThrow();
  });
  it("shadow without auth dependencies fails closed", async () => {
    await expect(
      buildApp({
        environment: loadEnvironment({ MOBILE_PUSH_REGISTRY_MODE: "shadow" }),
        logger: false
      })
    ).rejects.toThrow("PUSH_REGISTRY_DEPENDENCIES_REQUIRED");
  });
  it("raw DB exceptions cannot expose a token or URL", async () => {
    const sensitive = randomUUID();
    const database = {
      $transaction: async () => {
        throw new Error(sensitive);
      }
    } as unknown as DatabaseClient;
    const service = new DevicePushRegistry(
      database,
      {
        encrypt: async () => ({
          ciphertext: "opaque",
          provider: "test",
          keyVersion: "test"
        }),
        decrypt: async () => ""
      },
      "synthetic-pepper-with-thirty-two-characters"
    );
    await expect(
      service.get(
        {
          teamId: randomUUID(),
          principalKind: "OWNER",
          principalId: randomUUID()
        },
        randomUUID()
      )
    ).rejects.toMatchObject({
      code: "PUSH_REGISTRY_UNAVAILABLE"
    });
  });
  it("has no delivery table, network client or dispatcher wiring", async () => {
    const source = await readFile(
      new URL(
        "../src/modules/device-push/device-push-registry.ts",
        import.meta.url
      ),
      "utf8"
    );
    expect(
      /fetch\(|https?:\/\/|NotificationDelivery|ReliabilityOutbox|FakeTransport/u.test(
        source
      )
    ).toBe(false);
    const app = await readFile(
      new URL("../src/app.ts", import.meta.url),
      "utf8"
    );
    expect(app.includes('"body.deviceToken"')).toBe(true);
    expect(app.includes('"req.body.deviceToken"')).toBe(true);
  });
});
