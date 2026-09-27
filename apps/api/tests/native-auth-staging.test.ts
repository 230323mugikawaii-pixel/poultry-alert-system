import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { loadEnvironment } from "../src/config/env.js";
import { GoogleOAuthClient } from "../src/modules/auth/google-oauth-client.js";
import { MicrosoftLoginOAuthClient } from "../src/modules/auth/microsoft-login-oauth-client.js";
import {
  nativeClientId,
  nativeRedirectUri,
  pkceChallenge
} from "../src/modules/auth/native-auth-service.js";
import { nativeFixture } from "./helpers/native-auth-fixture.js";

const origin =
  "https://call-now-staging-api-404996456750.asia-northeast1.run.app";
const environment = () =>
  loadEnvironment({
    APP_ENV: "staging",
    PUBLIC_ORIGIN: origin,
    COOKIE_NAME: "callnow_staging_session",
    NATIVE_AUTH_MODE: "enabled",
    AUTH_TOKEN_PEPPER: "synthetic-staging-test-pepper-not-a-credential",
    GOOGLE_OAUTH_CLIENT_ID: "",
    GOOGLE_OAUTH_CLIENT_SECRET: "",
    GOOGLE_OAUTH_REDIRECT_URI: "",
    GMAIL_OAUTH_CLIENT_ID: "",
    GMAIL_OAUTH_CLIENT_SECRET: "",
    GMAIL_OAUTH_REDIRECT_URI: "",
    MICROSOFT_OAUTH_CLIENT_ID: "",
    MICROSOFT_OAUTH_CLIENT_SECRET: "",
    MICROSOFT_OAUTH_REDIRECT_URI: "",
    MAIL_TOKEN_ENCRYPTION_PROVIDER: "gcp-kms",
    MAIL_KMS_KEY_NAME:
      "projects/synthetic-staging/locations/asia-northeast1/keyRings/test/cryptoKeys/test"
  });

describe("staging native OAuth contract (synthetic providers only)", () => {
  it.each(["google", "microsoft"])(
    "%s HTTPS callback, secure binding and session, one-time PKCE exchange",
    async (provider) => {
      const f = await nativeFixture({ environment: environment() });
      try {
        const verifier = randomBytes(32).toString("base64url"),
          state = randomBytes(32).toString("base64url");
        const start = await f.app.inject(
          `/api/v1/auth/native/${provider}/start?${new URLSearchParams({
            client_id: nativeClientId,
            redirect_uri: nativeRedirectUri,
            response_type: "code",
            code_challenge_method: "S256",
            code_challenge: pkceChallenge(verifier),
            state
          })}`
        );
        expect(start.statusCode).toBe(302);
        const binding = start.cookies.find((c) => c.name.includes("_native_"))!;
        expect(binding).toMatchObject({
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
          path: `/api/v1/auth/${provider}`
        });
        const upstreamState = new URL(
          String(start.headers.location)
        ).searchParams.get("state")!;
        const callback = await f.app.inject({
          url: `/api/v1/auth/${provider}/callback?${new URLSearchParams({ state: upstreamState, code: upstreamState })}`,
          headers: { cookie: `${binding.name}=${binding.value}` }
        });
        expect(callback.statusCode).toBe(302);
        const handoff = new URL(String(callback.headers.location));
        expect(handoff.protocol).toBe("com.callnow.poultryalert:");
        expect(handoff.pathname).toBe("/oauth/callback");
        expect(handoff.searchParams.get("state")).toBe(state);
        const payload = {
          grant_type: "authorization_code",
          client_id: nativeClientId,
          redirect_uri: nativeRedirectUri,
          code: handoff.searchParams.get("code")!,
          code_verifier: verifier
        };
        const exchange = await f.app.inject({
          method: "POST",
          url: "/api/v1/auth/native/token",
          headers: { origin },
          payload
        });
        expect(exchange.statusCode).toBe(200);
        expect(Object.keys(exchange.json())).toEqual(["user"]);
        const session = exchange.cookies.find(
          (c) => c.name === f.environment.COOKIE_NAME
        )!;
        expect(session).toMatchObject({
          secure: true,
          httpOnly: true,
          sameSite: "Lax"
        });
        expect(exchange.headers["cache-control"]).toBe("no-store");
        const me = await f.app.inject({
          url: "/api/v1/auth/me",
          headers: { cookie: `${session.name}=${session.value}` }
        });
        expect(me.statusCode).toBe(200);
        expect(
          (
            await f.app.inject({
              method: "POST",
              url: "/api/v1/auth/native/token",
              headers: { origin },
              payload
            })
          ).statusCode
        ).toBe(401);
      } finally {
        await f.app.close();
      }
    }
  );

  it.each(["google", "microsoft"])(
    "%s real adapter generates staging web callback with S256 without network",
    (provider) => {
      const noNetwork = vi.fn<typeof fetch>(() => {
        throw new Error("NETWORK_FORBIDDEN_IN_TEST");
      });
      const config = {
        clientId: "synthetic-client",
        clientSecret: "synthetic-only-not-a-secret",
        redirectUri: `${origin}/api/v1/auth/${provider}/callback`
      };
      const adapter =
        provider === "google"
          ? new GoogleOAuthClient(config)
          : new MicrosoftLoginOAuthClient({
              ...config,
              tenant: "common",
              fetcher: noNetwork
            });
      const input = {
        state: "synthetic-state",
        nonce: "synthetic-nonce",
        codeChallenge: pkceChallenge("a".repeat(43))
      };
      const url = new URL(adapter.createAuthorizationUrl(input));
      expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual([
        "email",
        "openid",
        "profile"
      ]);
      expect(url.toString()).not.toContain(config.clientSecret);
      expect(noNetwork).not.toHaveBeenCalled();
    }
  );
});
