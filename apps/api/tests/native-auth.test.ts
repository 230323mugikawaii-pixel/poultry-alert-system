import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  nativeFixture,
  type MemoryNativeGrants
} from "./helpers/native-auth-fixture.js";
import {
  nativeClientId,
  nativeRedirectUri,
  pkceChallenge
} from "../src/modules/auth/native-auth-service.js";
import { loadEnvironment } from "../src/config/env.js";

type Fixture = Awaited<ReturnType<typeof nativeFixture>>;
const open: Fixture[] = [];
const fixture = async (mode?: "off" | "enabled") => {
  const f = await nativeFixture({ ...(mode ? { mode } : {}) });
  open.push(f);
  return f;
};
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.app.close()));
  vi.restoreAllMocks();
});
const random = () => randomBytes(32).toString("base64url");
const verifier = random();
const clientState = random();
const params = () => ({
  client_id: nativeClientId,
  redirect_uri: nativeRedirectUri,
  response_type: "code",
  code_challenge_method: "S256",
  code_challenge: pkceChallenge(verifier),
  state: clientState
});
const tokenBody = (code: string, secret = verifier) => ({
  client_id: nativeClientId,
  redirect_uri: nativeRedirectUri,
  grant_type: "authorization_code",
  code,
  code_verifier: secret
});
async function start(f: Fixture, provider = "google") {
  const res = await f.app.inject(
    `/api/v1/auth/native/${provider}/start?${new URLSearchParams(params())}`
  );
  expect(res.statusCode).toBe(302);
  const upstream = new URL(String(res.headers.location)).searchParams.get(
    "state"
  )!;
  const cookie = res.cookies.find((c) => c.name.includes("_native_"))!;
  return { upstream, cookie: `${cookie.name}=${cookie.value}` };
}
async function callback(f: Fixture, provider = "google") {
  const s = await start(f, provider);
  const r = await f.app.inject({
    url: `/api/v1/auth/${provider}/callback?${new URLSearchParams({ state: s.upstream, code: s.upstream })}`,
    headers: { cookie: s.cookie }
  });
  expect(r.statusCode).toBe(302);
  const url = new URL(String(r.headers.location));
  expect(url.searchParams.get("state")).toBe(clientState);
  expect(f.memory.sessions).toHaveLength(0);
  expect(r.cookies.some((c) => c.name === f.environment.COOKIE_NAME)).toBe(
    false
  );
  return {
    code: url.searchParams.get("code")!,
    upstream: s.upstream,
    cookie: s.cookie
  };
}
describe("native PKCE handoff", () => {
  it("rate limits exchanges without exposing a code or verifier", async () => {
    const f = await fixture();
    let last;
    for (let i = 0; i < 16; i++)
      last = await f.app.inject({
        method: "POST",
        url: "/api/v1/auth/native/token",
        headers: { origin: f.environment.PUBLIC_ORIGIN },
        payload: tokenBody(random())
      });
    expect(last?.statusCode).toBe(429);
    expect(Number(last?.headers["retry-after"])).toBeGreaterThan(0);
    expect(f.memory.sessions).toHaveLength(0);
  });
  it("session persistence failure consumes the code and requires a new login, never replay", async () => {
    const f = await fixture(),
      grant = await callback(f);
    vi.spyOn(f.auth, "createSessionForVerifiedUser").mockRejectedValueOnce(
      new Error("SYNTHETIC_SESSION_FAILURE")
    );
    const payload = tokenBody(grant.code);
    const first = await f.app.inject({
      method: "POST",
      url: "/api/v1/auth/native/token",
      headers: { origin: f.environment.PUBLIC_ORIGIN },
      payload
    });
    expect(first.statusCode).toBe(503);
    expect(first.body).not.toContain("SYNTHETIC_SESSION_FAILURE");
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/v1/auth/native/token",
          headers: { origin: f.environment.PUBLIC_ORIGIN },
          payload
        })
      ).statusCode
    ).toBe(401);
    expect(f.memory.sessions).toHaveLength(0);
  });
  it("off is default and no new service or routes are used", async () => {
    expect(loadEnvironment({ APP_ENV: "test" }).NATIVE_AUTH_MODE).toBe("off");
    const f = await fixture("off");
    expect(
      (await f.app.inject("/api/v1/auth/native/providers")).statusCode
    ).toBe(404);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/v1/auth/native/token",
          payload: tokenBody(random())
        })
      ).statusCode
    ).toBe(404);
    expect(f.constructed()).toBe(0);
  });
  it("matches the RFC7636 S256 vector", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
  });
  it.each(["google", "microsoft"])(
    "%s: independent browser binding, one-shot exchange, existing API session",
    async (provider) => {
      const f = await fixture(),
        grant = await callback(f, provider);
      const r = await f.app.inject({
        method: "POST",
        url: "/api/v1/auth/native/token",
        headers: { origin: f.environment.PUBLIC_ORIGIN },
        payload: tokenBody(grant.code)
      });
      expect(r.statusCode).toBe(200);
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(Object.keys(r.json())).toEqual(["user"]);
      const session = r.cookies.find(
        (c) => c.name === f.environment.COOKIE_NAME
      )!;
      expect(
        (
          await f.app.inject({
            url: "/api/v1/auth/me",
            headers: { cookie: `${session.name}=${session.value}` }
          })
        ).statusCode
      ).toBe(200);
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: "/api/v1/auth/native/token",
            headers: { origin: f.environment.PUBLIC_ORIGIN },
            payload: tokenBody(grant.code)
          })
        ).statusCode
      ).toBe(401);
      expect(f.memory.sessions).toHaveLength(1);
      const stored = JSON.stringify((f.grants as MemoryNativeGrants).rows);
      for (const secret of [
        grant.code,
        verifier,
        session.value,
        grant.upstream
      ])
        expect(stored.includes(secret)).toBe(false);
    }
  );
  it.each([
    { code_challenge_method: "plain" },
    { redirect_uri: "https://attacker.invalid/" },
    { client_id: "other" },
    { response_type: "token" },
    { code_challenge: "" },
    { state: "short" },
    { unexpected: "secret" }
  ])("rejects altered native contract %j", async (alteration) => {
    const f = await fixture();
    expect(
      (
        await f.app.inject(
          `/api/v1/auth/native/google/start?${new URLSearchParams({ ...params(), ...alteration })}`
        )
      ).statusCode
    ).toBe(400);
    expect((f.grants as MemoryNativeGrants).rows).toHaveLength(0);
  });
  it("missing/wrong browser binding and provider mixup do not complete", async () => {
    const f = await fixture(),
      s = await start(f);
    for (const provider of ["google", "microsoft"]) {
      const r = await f.app.inject({
        url: `/api/v1/auth/${provider}/callback?state=${s.upstream}&code=${s.upstream}`,
        headers: { cookie: `callnow_session_native_${provider}=${random()}` }
      });
      expect(r.statusCode).toBe(401);
    }
    expect(f.memory.sessions).toHaveLength(0);
  });
  it("callback is one-shot; cancellation redirects with bound state only", async () => {
    const f = await fixture(),
      s = await start(f);
    const path = `/api/v1/auth/google/callback?state=${s.upstream}&error=access_denied`;
    const r = await f.app.inject({ url: path, headers: { cookie: s.cookie } });
    const url = new URL(String(r.headers.location));
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe(clientState);
    expect(
      (await f.app.inject({ url: path, headers: { cookie: s.cookie } }))
        .statusCode
    ).toBe(401);
    expect(f.memory.sessions).toHaveLength(0);
  });
  it("wrong verifier and Origin never create a session", async () => {
    const f = await fixture(),
      grant = await callback(f);
    for (const [origin, secret, expected] of [
      ["https://attacker.invalid", verifier, 403],
      [f.environment.PUBLIC_ORIGIN, random(), 401]
    ] as const) {
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: "/api/v1/auth/native/token",
            headers: { origin },
            payload: tokenBody(grant.code, secret)
          })
        ).statusCode
      ).toBe(expected);
    }
    expect(f.memory.sessions).toHaveLength(0);
  });
  it("handoff expires after 60 seconds", async () => {
    const f = await fixture(),
      g = await callback(f);
    f.advance(60001);
    await expect(f.native.exchange(g.code, verifier, {})).rejects.toMatchObject(
      { code: "NATIVE_GRANT_INVALID" }
    );
  });
  it("browser flow expires after 10 minutes", async () => {
    const f = await fixture(),
      s = await start(f);
    f.advance(600001);
    expect(
      (
        await f.app.inject({
          url: `/api/v1/auth/google/callback?state=${s.upstream}&code=${s.upstream}`,
          headers: { cookie: s.cookie }
        })
      ).statusCode
    ).toBe(401);
  });
  it("invalid upstream code never returns an app code or session", async () => {
    const f = await fixture(),
      s = await start(f);
    const r = await f.app.inject({
      url: `/api/v1/auth/google/callback?state=${s.upstream}&code=invalid-synthetic-code`,
      headers: { cookie: s.cookie }
    });
    const url = new URL(String(r.headers.location));
    expect(url.searchParams.get("code")).toBeNull();
    expect(url.searchParams.get("error")).toBe("login_failed");
    expect(f.memory.sessions).toHaveLength(0);
  });
  it("raw DB/provider exceptions are not serialized", async () => {
    const f = await fixture();
    vi.spyOn(f.grants, "create").mockRejectedValueOnce(
      new Error("SYNTHETIC_PRIVATE_VALUE")
    );
    const r = await f.app.inject(
      `/api/v1/auth/native/google/start?${new URLSearchParams(params())}`
    );
    expect(r.statusCode).toBe(503);
    expect(r.body).not.toContain("SYNTHETIC_PRIVATE_VALUE");
  });
});
