import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants } from "node:http2";
import type * as Http2 from "node:http2";
import { jwtVerify, decodeProtectedHeader } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readApnsConfiguration,
  apnsPlannerConfiguration
} from "../src/modules/device-push/apns-config.js";
import { ApnsProviderToken } from "../src/modules/device-push/apns-jwt.js";
import {
  ApnsHttp2Transport,
  apnsPayload,
  apnsRequestId
} from "../src/modules/device-push/apns-http2-transport.js";
import {
  PushDeliveryWorker,
  pushOutcome
} from "../src/modules/device-push/push-delivery-worker.js";
import { FakePushTransport } from "../src/modules/device-push/push-transport.js";
import { runPushWorkerLoop } from "../src/modules/device-push/push-worker-loop.js";
import { createConfiguredApnsTransport } from "../src/modules/device-push/apns-runtime.js";
import {
  keys,
  apnsEnvironment,
  apnsConfiguration,
  apnsInput,
  startApnsMock
} from "./fixtures/apns-mock.js";
import { encryption } from "./fixtures/device-push-harness.js";

// Even an accidental runtime-factory call cannot resolve/connect an Apple host in this suite.
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

describe("PR07c local-only APNs transport", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const close of cleanups.splice(0).reverse()) await close();
    vi.restoreAllMocks();
  });
  const setup = async (
    handler?: Parameters<typeof startApnsMock>[0],
    options?: { now?: () => number; timeoutMs?: number }
  ) => {
    const mock = await startApnsMock(handler);
    cleanups.push(mock.close);
    const transport = ApnsHttp2Transport.forTest(
      apnsConfiguration(),
      encryption,
      mock.connect,
      options
    );
    cleanups.push(() => transport.close());
    return { mock, transport, ...(await apnsInput()) };
  };
  it("validates only PKCS8 P-256, escaped PEM, file source; secrets never appear in safe errors", async () => {
    const env = apnsEnvironment();
    expect(readApnsConfiguration(env).expirationSeconds).toBe(86400);
    expect(
      readApnsConfiguration({
        ...env,
        APNS_PRIVATE_KEY: env.APNS_PRIVATE_KEY.replaceAll("\n", "\\n")
      }).environment
    ).toBe("sandbox");
    const path = await mkdtemp(join(tmpdir(), "callnow-pr07c-synthetic-"));
    try {
      const file = join(path, "synthetic.p8");
      await writeFile(file, env.APNS_PRIVATE_KEY, { mode: 0o600 });
      expect(
        readApnsConfiguration({
          ...env,
          APNS_PRIVATE_KEY: "",
          APNS_PRIVATE_KEY_FILE: file
        }).topic
      ).toBe("example.callnow.test");
    } finally {
      await rm(path, { recursive: true });
    }
    for (const change of [
      { APP_ENV: "production" },
      { APNS_ENVIRONMENT: "" },
      { APNS_ENVIRONMENT: "unknown" },
      { APNS_TEAM_ID: "short" },
      { APNS_KEY_ID: "lowercase1" },
      { APNS_BUNDLE_ID: "bad topic" },
      { APNS_PRIVATE_KEY: "" },
      { APNS_PRIVATE_KEY: "PRIVATE_INVALID_KEY" },
      { APNS_PRIVATE_KEY_FILE: "/PRIVATE_PATH" },
      { APNS_PRIVATE_KEY: "", APNS_PRIVATE_KEY_FILE: "/PRIVATE_MISSING_PATH" },
      {
        APNS_PRIVATE_KEY: keys.privateKey
          .export({ format: "pem", type: "sec1" })
          .toString()
      },
      {
        APNS_PRIVATE_KEY: generateKeyPairSync("ec", { namedCurve: "secp384r1" })
          .privateKey.export({ format: "pem", type: "pkcs8" })
          .toString()
      },
      { APNS_EXPIRATION_SECONDS: "0" },
      { APNS_EXPIRATION_SECONDS: "1.1" },
      { APNS_EXPIRATION_SECONDS: "604801" }
    ]) {
      let error: unknown;
      try {
        readApnsConfiguration({ ...env, ...change });
      } catch (e) {
        error = e;
      }
      expect(
        error instanceof Error &&
          error.message === "APNS_CONFIGURATION_INVALID" &&
          error.cause === undefined
      ).toBe(true);
    }
    expect(apnsPlannerConfiguration({})).toBe("missing");
    expect(apnsPlannerConfiguration(env)).toBe("validated");
    expect(() =>
      apnsPlannerConfiguration({ ...env, APP_ENV: "production" })
    ).toThrow("APNS_PRODUCTION_FORBIDDEN");
  });
  it("JWT ES256 verifies, raw signature is 64 bytes; concurrent cache, 20/50/60 minute boundaries", async () => {
    let now = Date.now();
    const initial = now;
    const jwt = new ApnsProviderToken(apnsConfiguration(), () => now);
    const values = await Promise.all(
      Array.from({ length: 100 }, () => jwt.get())
    );
    expect(new Set(values).size).toBe(1);
    const token = values[0]!;
    const verified = await jwtVerify(token, keys.publicKey, {
      algorithms: ["ES256"]
    });
    expect(
      verified.payload.iss === "SYNTHETIC1" &&
        verified.payload.iat === Math.floor(now / 1000)
    ).toBe(true);
    expect(decodeProtectedHeader(token)).toEqual({
      alg: "ES256",
      kid: "SYNTHETIC2"
    });
    expect(Buffer.from(token.split(".")[2]!, "base64url").length).toBe(64);
    now = initial + 19 * 60_000;
    expect((await jwt.get()) === token).toBe(true);
    expect(await jwt.expired(token)).toBe(false);
    now = initial + 20 * 60_000;
    expect(await jwt.expired(token)).toBe(true);
    const next = await jwt.get();
    expect(next !== token).toBe(true);
    expect(await jwt.expired(token)).toBe(true);
    expect((await jwt.get()) === next).toBe(true);
    now += 50 * 60_000;
    const rotated = await jwt.get();
    expect(rotated !== next).toBe(true);
    now += 61 * 60_000;
    expect((await jwt.get()) !== rotated).toBe(true);
    now = initial - 1;
    await expect(jwt.get()).rejects.toThrow("APNS_CLOCK_INVALID");
  });
  it("100 concurrent ExpiredProviderToken responses rotate once, without false config halt", async () => {
    let now = Date.now();
    const jwt = new ApnsProviderToken(apnsConfiguration(), () => now),
      token = await jwt.get();
    now += 20 * 60_000;
    expect(
      (
        await Promise.all(Array.from({ length: 100 }, () => jwt.expired(token)))
      ).every(Boolean)
    ).toBe(true);
    expect((await jwt.get()) !== token).toBe(true);
  });
  it("HTTP2 path/headers/private fixed payload, stable IDs, one reused session", async () => {
    const { mock, transport, input, token } = await setup(undefined, {
      now: () => 1_800_000_000_000
    });
    const signal = new AbortController().signal;
    const a = await transport.send(input, signal),
      b = await transport.send({ ...input, attemptId: randomUUID() }, signal);
    expect(a).toEqual({
      kind: "ACCEPTED",
      providerRequestId: apnsRequestId(input.idempotencyKey)
    });
    expect(b).toEqual(a);
    expect(mock.connections).toBe(1);
    expect(mock.requests).toHaveLength(2);
    const r = mock.requests[0]!;
    expect(r.headers[":path"] === `/3/device/${token}`).toBe(true);
    expect(r.headers[":method"]).toBe("POST");
    expect(r.headers["apns-topic"]).toBe("example.callnow.test");
    expect(r.headers["apns-push-type"]).toBe("alert");
    expect(r.headers["apns-priority"]).toBe("10");
    expect(r.headers["apns-expiration"]).toBe(String(1_800_000_000 + 86400));
    expect(
      Buffer.byteLength(String(r.headers["apns-collapse-id"]))
    ).toBeLessThanOrEqual(64);
    expect(r.headers["apns-collapse-id"]).toBe(
      mock.requests[1]!.headers["apns-collapse-id"]
    );
    const jwt = String(r.headers.authorization).slice(7);
    expect(
      (await jwtVerify(jwt, keys.publicKey)).payload.iss === "SYNTHETIC1"
    ).toBe(true);
    const body: unknown = JSON.parse(r.body);
    expect(body).toEqual(JSON.parse(apnsPayload(input.alertId)));
    expect(Buffer.byteLength(r.body)).toBeLessThan(4096);
    expect(
      r.body.includes(token) ||
        r.body.includes("@") ||
        r.body.includes("keyword")
    ).toBe(false);
  });
  it.each([undefined, "invalid", "00000000-0000-4000-8000-000000000001"])(
    "200 with absent/invalid/different receipt uses deterministic sent ID (%s)",
    async (header) => {
      const { transport, input } = await setup((s) => {
        s.respond({ ":status": 200, ...(header ? { "apns-id": header } : {}) });
        s.end();
      });
      expect(await transport.send(input, new AbortController().signal)).toEqual(
        {
          kind: "ACCEPTED",
          providerRequestId: apnsRequestId(input.idempotencyKey)
        }
      );
    }
  );
  const cases: [number, string, string, string][] = [
    [410, "Unregistered", "PERMANENT", "HTTP_410"],
    [410, "ExpiredToken", "PERMANENT", "HTTP_410"],
    [400, "BadDeviceToken", "PERMANENT", "APNS_BAD_DEVICE_TOKEN"],
    [400, "DeviceTokenNotForTopic", "PERMANENT", "APNS_TOKEN_NOT_FOR_TOPIC"],
    [429, "TooManyRequests", "RETRY", "HTTP_429"],
    [500, "InternalServerError", "RETRY", "HTTP_5XX"],
    [500, "ServiceUnavailable", "RETRY", "HTTP_5XX"],
    [403, "Forbidden", "RETRY", "APNS_FORBIDDEN"],
    [413, "PayloadTooLarge", "RETRY", "APNS_PAYLOAD_TOO_LARGE"],
    [503, "ServiceUnavailable", "RETRY", "HTTP_5XX"],
    [503, "Shutdown", "RETRY", "APNS_CONNECTION"],
    [400, "IdleTimeout", "RETRY", "APNS_CONNECTION"],
    [403, "UnrelatedKeyIdInToken", "RETRY", "APNS_CONNECTION"],
    ...[
      "InvalidProviderToken",
      "MissingProviderToken",
      "BadEnvironmentKeyIdInToken",
      "BadCertificate",
      "BadCertificateEnvironment"
    ].map((r): [number, string, string, string] => [
      403,
      r,
      "RETRY",
      "APNS_CONFIG"
    ]),
    ...[
      "BadTopic",
      "TopicDisallowed",
      "MissingTopic",
      "BadCollapseId",
      "BadExpirationDate",
      "BadMessageId",
      "BadPriority",
      "DuplicateHeaders",
      "InvalidPushType",
      "MissingDeviceToken",
      "PayloadEmpty"
    ].map((r): [number, string, string, string] => [
      400,
      r,
      "RETRY",
      "APNS_CONFIG"
    ]),
    [404, "BadPath", "RETRY", "APNS_CONFIG"],
    [405, "MethodNotAllowed", "RETRY", "APNS_CONFIG"],
    [429, "TooManyProviderTokenUpdates", "RETRY", "APNS_CONFIG"],
    [499, "PRIVATE_UNKNOWN_REASON", "RETRY", "APNS_CONFIG"]
  ];
  it.each(cases)(
    "classifies status %s reason %s without persisting raw provider strings",
    async (status, reason, kind, code) => {
      const { transport, input } = await setup((s) => {
        s.respond({ ":status": Number(status), "retry-after": "2" });
        s.end(JSON.stringify({ reason }));
      });
      const result = await transport.send(input, new AbortController().signal);
      expect(result).toMatchObject({ kind, code });
      if (result.kind === "RETRY") {
        expect(result.retryAfterMs).toBeGreaterThanOrEqual(
          code === "HTTP_5XX" ? 900_000 : 1000
        );
        if (code === "APNS_CONFIG") expect(result.stop).toBe(true);
      }
      expect(JSON.stringify(result).includes("PRIVATE_UNKNOWN_REASON")).toBe(
        false
      );
    }
  );
  it.each([
    "invalid-json",
    "{}",
    JSON.stringify({ reason: { private: "data" } }),
    "x".repeat(5000)
  ])("malformed/bounded response fails closed (%#)", async (body) => {
    const { transport, input } = await setup((s) => {
      s.respond({ ":status": 403 });
      s.end(body);
    });
    expect(await transport.send(input, new AbortController().signal)).toEqual({
      kind: "RETRY",
      code: "APNS_CONFIG",
      retryAfterMs: 300_000,
      stop: true
    });
  });
  it("ExpiredProviderToken older than 20min rotates JWT; early rejection halts", async () => {
    let now = Date.now(),
      fail = false;
    const { mock, transport, input } = await setup(
      (s) => {
        s.respond({ ":status": fail ? 403 : 200 });
        s.end(fail ? JSON.stringify({ reason: "ExpiredProviderToken" }) : "");
      },
      { now: () => now }
    );
    const signal = new AbortController().signal;
    await transport.send(input, signal);
    fail = true;
    now += 20 * 60_000;
    expect(await transport.send(input, signal)).toMatchObject({
      kind: "RETRY",
      code: "APNS_TOKEN_REFRESH"
    });
    fail = false;
    await transport.send(input, signal);
    expect(
      mock.requests[0]!.headers.authorization !==
        mock.requests[2]!.headers.authorization
    ).toBe(true);
    fail = true;
    expect(await transport.send(input, signal)).toMatchObject({
      code: "APNS_CONFIG",
      stop: true
    });
  });
  it("GOAWAY Shutdown cancels request and reconnects; no duplicate session per new request", async () => {
    let first = true;
    const { transport, input, mock } = await setup((s) => {
      if (first) {
        first = false;
        s.session!.goaway(
          0,
          s.id,
          Buffer.from(JSON.stringify({ reason: "Shutdown" }))
        );
      } else {
        s.respond({ ":status": 200 });
        s.end();
      }
    });
    expect(
      await transport.send(input, new AbortController().signal)
    ).toMatchObject({ code: "APNS_CONNECTION" });
    expect(
      await transport.send(input, new AbortController().signal)
    ).toMatchObject({ kind: "ACCEPTED" });
    expect(mock.connections).toBe(2);
  });
  it.each(["reset", "timeout", "abort"])(
    "%s cancels stream without false acceptance",
    async (action) => {
      const { transport, input, mock } = await setup(
        (s) => {
          if (action === "reset") s.close(constants.NGHTTP2_INTERNAL_ERROR);
        },
        { timeoutMs: 30 }
      );
      const controller = new AbortController();
      const result = transport.send(input, controller.signal);
      if (action === "abort") setTimeout(() => controller.abort(), 10);
      expect(await result).toMatchObject({
        kind: "RETRY",
        code: "APNS_CONNECTION"
      });
      expect(mock.requests.length).toBeLessThanOrEqual(1);
    }
  );
  it("rotation after prepare but before final check does not send old token", async () => {
    const { transport, input, mock } = await setup();
    expect(
      await transport.send(
        { ...input, confirmCurrent: async () => false },
        new AbortController().signal
      )
    ).toMatchObject({ code: "APNS_TARGET_STALE" });
    expect(mock.requests).toHaveLength(0);
    expect(mock.connections).toBe(0);
  });
  it.each(["APNS_CONFIG", "APNS_FORBIDDEN", "APNS_PAYLOAD_TOO_LARGE"])(
    "%s latches circuit even if finish fails; CLI loop returns exit 1",
    async (code) => {
      const { input } = await apnsInput();
      const queue = {
        claimOne: vi.fn(async () => ({
          id: input.deliveryId,
          leaseToken: input.attemptId,
          leaseGeneration: 1n,
          attemptCount: 1
        })),
        prepare: vi.fn(async () => input),
        finish: vi.fn(async () => {
          throw new Error("PRIVATE_DB_ERROR");
        })
      };
      const transport = {
        mode: "apns" as const,
        send: vi.fn(async () => ({
          kind: "RETRY" as const,
          code,
          retryAfterMs: 300_000,
          stop: true as const
        }))
      };
      const worker = new PushDeliveryWorker(queue, transport, { mode: "apns" }),
        errors: string[] = [];
      expect(
        await runPushWorkerLoop(worker, {
          signal: new AbortController().signal,
          once: false,
          step: () => {},
          error: (c) => {
            errors.push(c);
          }
        })
      ).toBe(1);
      expect(await worker.runOnce()).toBe("STOPPED");
      expect(queue.claimOne).toHaveBeenCalledTimes(1);
      expect(errors).toEqual(["PUSH_WORKER_DATABASE_ERROR", code]);
    }
  );
  it("runtime endpoints are fixed and test connector is unavailable outside tests; no external connection", async () => {
    const { input } = await apnsInput();
    for (const environment of ["sandbox", "production"] as const) {
      const transport = ApnsHttp2Transport.create(
        { ...apnsConfiguration(), environment },
        encryption
      );
      cleanups.push(() => transport.close());
      // Network guard rejects the fixed Apple address BEFORE real http2.connect/DNS can be called.
      expect(
        await transport.send(input, new AbortController().signal)
      ).toMatchObject({ code: "APNS_CONNECTION" });
    }
    vi.stubEnv("NODE_ENV", "development");
    try {
      expect(() =>
        ApnsHttp2Transport.forTest(apnsConfiguration(), encryption, vi.fn())
      ).toThrow("APNS_TEST_FACTORY_FORBIDDEN");
    } finally {
      vi.unstubAllEnvs();
    }
    expect(() =>
      createConfiguredApnsTransport({
        ...apnsEnvironment(),
        MAIL_TOKEN_ENCRYPTION_PROVIDER: "invalid"
      })
    ).toThrow("APNS_ENCRYPTION_CONFIGURATION_INVALID");
  });
  it("unknown GOAWAY is config stop, session connection error is retry", async () => {
    const a = await setup((s) =>
      s.session!.goaway(
        0,
        s.id,
        Buffer.from(JSON.stringify({ reason: "PRIVATE_UNKNOWN" }))
      )
    );
    expect(
      await a.transport.send(a.input, new AbortController().signal)
    ).toMatchObject({ code: "APNS_CONFIG", stop: true });
    const b = await setup((s) => s.session!.destroy());
    expect(
      await b.transport.send(b.input, new AbortController().signal)
    ).toMatchObject({ code: "APNS_CONNECTION" });
  });
  it("failed decryption and invalid token never reach HTTP2 or expose raw error", async () => {
    const { mock, input } = await setup();
    for (const decrypt of [
      async () => {
        throw new Error("PRIVATE_DECRYPTION_DETAILS");
      },
      async () => "PRIVATE_INVALID_TOKEN"
    ]) {
      const transport = ApnsHttp2Transport.forTest(
        apnsConfiguration(),
        { encrypt: (t) => encryption.encrypt(t), decrypt },
        mock.connect
      );
      cleanups.push(() => transport.close());
      expect(await transport.send(input, new AbortController().signal)).toEqual(
        {
          kind: "RETRY",
          code: "APNS_CONFIG",
          retryAfterMs: 300_000,
          stop: true
        }
      );
    }
    expect(mock.requests).toHaveLength(0);
  });
  it("circuit exits an actual child process nonzero after persisting RETRY_WAIT, with exactly one claim", () => {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(
          new URL("./fixtures/apns-circuit-child.ts", import.meta.url)
        )
      ],
      {
        encoding: "utf8",
        timeout: 10000,
        env: { PATH: process.env.PATH, NODE_ENV: "test" }
      }
    );
    expect(child.status).toBe(1);
    expect(child.stderr).toBe("");
    expect(JSON.parse(child.stdout)).toEqual({
      claims: 1,
      states: ["RETRY_WAIT"]
    });
  });
  it("stream reset discards the old session and next send reconnects", async () => {
    let attempts = 0;
    const { transport, mock, input } = await setup((s, h) => {
      if (++attempts === 1) s.close(constants.NGHTTP2_INTERNAL_ERROR);
      else {
        s.respond({ ":status": 200, "apns-id": h.headers["apns-id"] });
        s.end();
      }
    });
    expect(
      await transport.send(input, new AbortController().signal)
    ).toMatchObject({ code: "APNS_CONNECTION" });
    expect(
      (await transport.send(input, new AbortController().signal)).kind
    ).toBe("ACCEPTED");
    expect(mock.connections).toBe(2);
  });
  it("Retry-After date or seconds never shortens the 5xx 15-minute floor", async () => {
    const now = Date.now();
    for (const after of [
      "1200",
      new Date(now + 1200000).toUTCString(),
      "1",
      "invalid"
    ]) {
      const { transport, input } = await setup(
        (s) => {
          s.respond({ ":status": 503, "retry-after": after });
          s.end(JSON.stringify({ reason: "ServiceUnavailable" }));
        },
        { now: () => now }
      );
      const result = await transport.send(input, new AbortController().signal);
      expect(result.kind).toBe("RETRY");
      if (result.kind === "RETRY")
        expect(result.retryAfterMs).toBeGreaterThanOrEqual(
          after.length > 10 ? 1199000 : after === "1200" ? 1200000 : 900000
        );
    }
  });
  it("mode mismatch rejected before claim; Fake and APNs result allowlists are separate", async () => {
    const q = { claimOne: vi.fn(), prepare: vi.fn(), finish: vi.fn() };
    await expect(
      new PushDeliveryWorker(q, new FakePushTransport(), {
        mode: "apns"
      }).runOnce()
    ).rejects.toThrow("PUSH_TRANSPORT_MODE_MISMATCH");
    const { transport } = await setup();
    await expect(
      new PushDeliveryWorker(q, transport, { mode: "shadow" }).runOnce()
    ).rejects.toThrow("PUSH_REAL_TRANSPORT_FORBIDDEN");
    expect(q.claimOne).not.toHaveBeenCalled();
    expect(
      pushOutcome(
        { kind: "RETRY", code: "FAKE_TRANSIENT", retryAfterMs: 1000 },
        1,
        "apns"
      )
    ).toMatchObject({ code: "TRANSPORT_RESULT_INVALID" });
    expect(
      pushOutcome(
        { kind: "RETRY", code: "APNS_CONFIG", retryAfterMs: 1000 },
        1,
        "fake"
      )
    ).toMatchObject({ code: "TRANSPORT_RESULT_INVALID" });
  });
  it("CLI off ignores invalid APNs configuration; apns production/missing config exits nonzero without network", () => {
    const path = fileURLToPath(
      new URL("../src/cli/push-deliveries.ts", import.meta.url)
    );
    for (const [mode, appEnv, expected] of [
      ["off", "test", 0],
      ["apns", "production", 1],
      ["apns", "test", 1]
    ] as const) {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", path, "--once"],
        {
          env: {
            PATH: process.env.PATH,
            MOBILE_PUSH_DELIVERY_MODE: mode,
            APP_ENV: appEnv,
            APNS_PRIVATE_KEY: "PRIVATE_SENTINEL"
          },
          encoding: "utf8"
        }
      );
      expect(result.status).toBe(expected);
      expect((result.stdout + result.stderr).includes("PRIVATE_SENTINEL")).toBe(
        false
      );
    }
  });
});
