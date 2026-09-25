import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type * as Http2 from "node:http2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runApnsSmoke } from "../src/modules/device-push/apns-smoke.js";
import { apnsEnvironment, startApnsMock } from "./fixtures/apns-mock.js";

const guard = vi.hoisted(() => ({
  redirect: undefined as (() => Http2.ClientHttp2Session) | undefined,
  sandboxRequests: 0,
  forbiddenRequests: 0,
  databaseCalls: 0
}));
vi.mock("../src/db/client.js", () => ({
  createDatabaseClient: () => {
    guard.databaseCalls++;
    throw new Error("SMOKE_DB_FORBIDDEN");
  }
}));
vi.mock("node:http2", async (original) => {
  const module = await original<typeof Http2>();
  return {
    ...module,
    connect: (authority: string | URL, ...args: unknown[]) => {
      // The unmodified runtime factory selects sandbox. Redirect BEFORE native connect/DNS.
      if (
        String(authority) === "https://api.sandbox.push.apple.com:443" &&
        guard.redirect
      ) {
        guard.sandboxRequests++;
        return guard.redirect();
      }
      const url = new URL(authority);
      if (url.protocol === "http:" && url.hostname === "127.0.0.1")
        return Reflect.apply(module.connect, module, [
          authority,
          ...args
        ]) as Http2.ClientHttp2Session;
      guard.forbiddenRequests++;
      throw new Error("SMOKE_NON_LOOPBACK_FORBIDDEN");
    }
  };
});

describe("PR07c-smoke runner (never execute actual smoke CLI)", () => {
  const cleanup: (() => Promise<void>)[] = [];
  beforeEach(() => {
    guard.redirect = undefined;
    guard.sandboxRequests = guard.forbiddenRequests = guard.databaseCalls = 0;
  });
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    expect(guard.forbiddenRequests).toBe(0);
    expect(guard.databaseCalls).toBe(0);
    vi.restoreAllMocks();
  });
  const mock = async (handler?: Parameters<typeof startApnsMock>[0]) => {
    const server = await startApnsMock(handler);
    guard.redirect = server.connect;
    cleanup.push(server.close);
    return server;
  };
  const invoke = async (
    args: string[],
    env: NodeJS.ProcessEnv = apnsEnvironment(),
    stdin: Readable = Readable.from([]),
    signal = new AbortController().signal
  ) => {
    const lines: string[] = [];
    const exit = await runApnsSmoke(args, env, {
      stdin,
      signal,
      write: (line) => {
        lines.push(line);
      }
    });
    expect(lines).toHaveLength(1);
    const output: unknown = JSON.parse(lines[0]!);
    return { exit, output, text: lines.join("") };
  };
  const tokenFile = async (contents: string) => {
    const dir = await mkdtemp(join(tmpdir(), "callnow-smoke-synthetic-"));
    cleanup.push(() => rm(dir, { recursive: true }));
    const file = join(dir, "synthetic-token");
    await writeFile(file, contents, { mode: 0o600 });
    return file;
  };
  it("missing confirmation exits 1 before configuration, file/stdin or transport access", async () => {
    const env = new Proxy(
      {},
      {
        get: () => {
          throw new Error("SHOULD_NOT_READ_ENV");
        }
      }
    );
    const stdin = new Readable({
      read: () => {
        throw new Error("SHOULD_NOT_READ_STDIN");
      }
    });
    const { exit, output } = await invoke(
      ["--token-file", "/PRIVATE_NONEXISTENT"],
      env,
      stdin
    );
    expect(exit).toBe(1);
    expect(output).toEqual({
      result: "PERMANENT",
      code: "APNS_SMOKE_CONFIRMATION_REQUIRED"
    });
    expect(guard.sandboxRequests).toBe(0);
    expect(stdin.destroyed).toBe(false);
  });
  it("APP_ENV production rejects before keys or token input", async () => {
    const { exit, output } = await invoke(
      ["--confirm-real-push", "--token-stdin"],
      { APP_ENV: "production" }
    );
    expect(exit).toBe(1);
    expect(output).toEqual({
      result: "PERMANENT",
      code: "APNS_PRODUCTION_FORBIDDEN"
    });
    expect(guard.sandboxRequests).toBe(0);
  });
  it.each(
    [
      [],
      ["--token-stdin", "--token-stdin"],
      ["--token-file"],
      ["--token-file", "--token-stdin"],
      ["--token-file", ""],
      ["--token-file", "unused", "--token-stdin"],
      ["--token-file", "unused", "--token-file", "other"],
      ["--token-stdin", "--confirm-real-push"],
      ["--token", "PRIVATE_DIRECT_TOKEN"],
      ["--token=PRIVATE_DIRECT_TOKEN"],
      ["--token-stdin", "PRIVATE_POSITIONAL_TOKEN"],
      ["--token-stdin", "--endpoint", "PRIVATE_URL"]
    ].map((args) => ({ args }))
  )(
    "rejects ambiguous/duplicate/missing/direct-token/endpoint arguments (%#)",
    async ({ args }) => {
      const { exit, output, text } = await invoke([
        "--confirm-real-push",
        ...args
      ]);
      expect(exit).toBe(1);
      expect(output).toEqual({
        result: "PERMANENT",
        code: "APNS_SMOKE_ARGUMENTS_INVALID"
      });
      expect(text.includes("PRIVATE")).toBe(false);
      expect(guard.sandboxRequests).toBe(0);
    }
  );
  it.each([undefined, "", "invalid"])(
    "invalid original APNS_ENVIRONMENT=%s is not masked by sandbox override",
    async (environment) => {
      const { exit, output } = await invoke(
        ["--confirm-real-push", "--token-stdin"],
        { ...apnsEnvironment(), APNS_ENVIRONMENT: environment }
      );
      expect(exit).toBe(1);
      expect(output).toEqual({
        result: "PERMANENT",
        code: "APNS_CONFIGURATION_INVALID"
      });
      expect(guard.sandboxRequests).toBe(0);
    }
  );
  it.each(["sandbox", "production"])(
    "file input with env=%s reaches only sandbox-selected local mock once; output is receipt only",
    async (environment) => {
      const server = await mock(),
        token = randomBytes(32).toString("hex");
      const file = await tokenFile(`${token.toUpperCase()}\r\n`);
      const env = {
        ...apnsEnvironment(),
        APNS_ENVIRONMENT: environment,
        DATABASE_URL: "PRIVATE_UNUSED_DB",
        MAIL_TOKEN_ENCRYPTION_PROVIDER: "gcp-kms",
        MAIL_KMS_KEY_NAME: "PRIVATE_UNUSED_KMS"
      };
      const { exit, output, text } = await invoke(
        ["--confirm-real-push", "--token-file", file],
        env
      );
      expect(exit).toBe(0);
      const accepted = output as { result: string; apnsId: string };
      expect(Object.keys(accepted).sort()).toEqual(["apnsId", "result"]);
      expect(accepted.result).toBe("ACCEPTED");
      expect(accepted.apnsId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(guard.sandboxRequests).toBe(1);
      expect(server.requests).toHaveLength(1);
      expect(
        server.requests[0]!.headers[":path"] === `/3/device/${token}`
      ).toBe(true);
      const json = JSON.parse(server.requests[0]!.body) as {
        callnow: { alertId: string };
      };
      expect(json.callnow.alertId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(
        text.includes(token) ||
          text.includes(file) ||
          text.includes(env.APNS_PRIVATE_KEY)
      ).toBe(false);
    }
  );
  it("stdin works with a fresh synthetic Alert UUID per invocation, no existing DB even configured", async () => {
    const server = await mock(),
      token = randomBytes(40).toString("hex");
    for (let i = 0; i < 2; i++) {
      const { exit } = await invoke(
        ["--token-stdin", "--confirm-real-push"],
        apnsEnvironment(),
        Readable.from([token.slice(0, 10), token.slice(10), "\n"])
      );
      expect(exit).toBe(0);
    }
    expect(server.requests).toHaveLength(2);
    const ids = server.requests.map(
      (r) =>
        (JSON.parse(r.body) as { callnow: { alertId: string } }).callnow.alertId
    );
    expect(new Set(ids).size).toBe(2);
    expect(
      server.requests.every((r) => r.headers[":path"] === `/3/device/${token}`)
    ).toBe(true);
  });
  it.each(["", "z1", "a", "ab".repeat(513), "ab cd", "a".repeat(5000)])(
    "invalid or oversized stdin fails without transport (%#)",
    async (token) => {
      const { exit, output } = await invoke(
        ["--confirm-real-push", "--token-stdin"],
        apnsEnvironment(),
        Readable.from([token])
      );
      expect(exit).toBe(1);
      expect(output).toEqual({
        result: "PERMANENT",
        code: "APNS_SMOKE_TOKEN_INPUT_INVALID"
      });
      expect(guard.sandboxRequests).toBe(0);
    }
  );
  it("I/O error and missing file cannot leak paths or raw errors", async () => {
    const a = await invoke([
      "--confirm-real-push",
      "--token-file",
      "/PRIVATE_MISSING_TOKEN_FILE"
    ]);
    const b = await invoke(
      ["--confirm-real-push", "--token-stdin"],
      apnsEnvironment(),
      new Readable({
        read() {
          this.destroy(new Error("PRIVATE_RAW_IO_ERROR"));
        }
      })
    );
    for (const { exit, text } of [a, b]) {
      expect(exit).toBe(1);
      expect(text.includes("PRIVATE") || text.includes("ENOENT")).toBe(false);
    }
  });
  it("abort while reading stdin finishes without building transport", async () => {
    const controller = new AbortController(),
      stdin = new Readable({ read() {} });
    const pending = invoke(
      ["--confirm-real-push", "--token-stdin"],
      apnsEnvironment(),
      stdin,
      controller.signal
    );
    controller.abort();
    const { exit, output } = await pending;
    expect(exit).toBe(1);
    expect(output).toEqual({
      result: "PERMANENT",
      code: "APNS_SMOKE_CANCELLED"
    });
    expect(guard.sandboxRequests).toBe(0);
    expect(stdin.destroyed).toBe(true);
  });
  it.each([
    [429, "TooManyRequests", "RETRY", "HTTP_429"],
    [410, "Unregistered", "PERMANENT", "HTTP_410"],
    [400, "BadDeviceToken", "PERMANENT", "APNS_BAD_DEVICE_TOKEN"],
    [403, "PRIVATE_RAW_PROVIDER_BODY", "RETRY", "APNS_CONFIG"]
  ] as const)(
    "provider response normalized, one send, no headers/body/secrets in output (%#)",
    async (status, reason, result, code) => {
      const token = randomBytes(32).toString("hex"),
        server = await mock((s) => {
          s.respond({
            ":status": status,
            "private-header": "PRIVATE_RAW_HEADER"
          });
          s.end(JSON.stringify({ reason, private: token }));
        });
      const { exit, output, text } = await invoke(
        ["--confirm-real-push", "--token-stdin"],
        apnsEnvironment(),
        Readable.from([token])
      );
      expect(exit).toBe(1);
      expect(output).toEqual({ result, code });
      expect(server.requests).toHaveLength(1);
      expect(
        text.includes("PRIVATE") ||
          text.includes(token) ||
          text.includes("bearer")
      ).toBe(false);
    }
  );
  it("invalid key produces only existing configuration code, never raw key or file error", async () => {
    const env = {
      ...apnsEnvironment(),
      APNS_PRIVATE_KEY: "PRIVATE_SYNTHETIC_INVALID_KEY"
    };
    const { exit, output, text } = await invoke(
      ["--confirm-real-push", "--token-stdin"],
      env
    );
    expect(exit).toBe(1);
    expect(output).toEqual({
      result: "PERMANENT",
      code: "APNS_CONFIGURATION_INVALID"
    });
    expect(text.includes(env.APNS_PRIVATE_KEY)).toBe(false);
    expect(guard.sandboxRequests).toBe(0);
  });
  it("abort during one local request cancels without retry or false ACCEPTED", async () => {
    const controller = new AbortController(),
      server = await mock(() => controller.abort());
    const { exit, output } = await invoke(
      ["--confirm-real-push", "--token-stdin"],
      apnsEnvironment(),
      Readable.from([randomBytes(32).toString("hex")]),
      controller.signal
    );
    expect(exit).toBe(1);
    expect(output).toEqual({ result: "RETRY", code: "APNS_CONNECTION" });
    expect(server.requests).toHaveLength(1);
  });
  it("package scripts point only at independent wrapper; wrapper/command are never run by tests", async () => {
    const api = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8")
    ) as { scripts: Record<string, string> };
    const root = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8")
    ) as { scripts: Record<string, string> };
    expect(api.scripts["push:apns-smoke"]).toBe("tsx src/cli/apns-smoke.ts");
    expect(root.scripts["push:apns-smoke"]).toBe(
      "pnpm --filter @call-now/api push:apns-smoke"
    );
    const source = await readFile(
      new URL("../src/cli/apns-smoke.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toMatch(
      /createDatabaseClient|dotenv|\.send\(|http2|server\.js/u
    );
    expect(source).toContain("process.exitCode = await runApnsSmoke");
  });
});
