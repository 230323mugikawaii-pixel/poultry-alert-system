import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  exportPKCS8,
  generateKeyPair
} from "jose";
import { describe, expect, it } from "vitest";
import { AppleLoginOAuthClient } from "../src/modules/auth/apple-login-oauth-client.js";
import { MicrosoftLoginOAuthClient } from "../src/modules/auth/microsoft-login-oauth-client.js";

describe("primary login provider clients", () => {
  it("keeps Microsoft login scopes separate from Microsoft mail monitoring", () => {
    const client = new MicrosoftLoginOAuthClient({
      clientId: "microsoft-login-client",
      clientSecret: "synthetic-test-secret",
      redirectUri:
        "https://api.test.call-now.example/api/v1/auth/microsoft/callback",
      tenant: "common"
    });
    const url = new URL(
      client.createAuthorizationUrl({
        state: "s".repeat(43),
        codeChallenge: "c".repeat(43),
        nonce: "n".repeat(43)
      })
    );
    const scopes = (url.searchParams.get("scope") ?? "").split(" ");

    expect(scopes).toEqual(["openid", "profile", "email"]);
    expect(scopes).not.toContain("Mail.Read");
    expect(scopes).not.toContain("offline_access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBe("n".repeat(43));
  });

  it("accepts an Apple relay identity and first-authorization name safely", async () => {
    const clientId = "example.call-now.web";
    const nonce = "n".repeat(43);
    const appleSigningKeys = await generateKeyPair("RS256");
    const appleJwk = await exportJWK(appleSigningKeys.publicKey);
    appleJwk.kid = "apple-signing-key";
    appleJwk.alg = "RS256";
    appleJwk.use = "sig";
    const idToken = await new SignJWT({
      email: "relay@privaterelay.appleid.com",
      email_verified: "true",
      nonce
    })
      .setProtectedHeader({ alg: "RS256", kid: appleJwk.kid })
      .setIssuer("https://appleid.apple.com")
      .setAudience(clientId)
      .setSubject("apple-user-subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(appleSigningKeys.privateKey);
    const clientSecretKeys = await generateKeyPair("ES256", {
      extractable: true
    });
    const privateKey = await exportPKCS8(clientSecretKeys.privateKey);
    let tokenRequestBodyText = "";
    const fetcher: typeof fetch = async (_input, init) => {
      if (!(init?.body instanceof URLSearchParams)) {
        throw new Error("expected_url_encoded_token_request");
      }
      tokenRequestBodyText = init.body.toString();
      return new Response(JSON.stringify({ id_token: idToken }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const client = new AppleLoginOAuthClient({
      clientId,
      teamId: "APPLETEAM1",
      keyId: "APPLEKEY1",
      privateKey,
      redirectUri:
        "https://api.test.call-now.example/api/v1/auth/apple/callback",
      fetcher,
      keySet: createLocalJWKSet({ keys: [appleJwk] })
    });
    const authorizationUrl = new URL(
      client.createAuthorizationUrl({
        state: "s".repeat(43),
        codeChallenge: "c".repeat(43),
        nonce
      })
    );

    expect(authorizationUrl.searchParams.get("response_mode")).toBe(
      "form_post"
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe("name email");
    expect(authorizationUrl.searchParams.get("code_challenge")).toBeNull();

    const profile = await client.exchangeCode({
      code: "synthetic-apple-authorization-code",
      codeVerifier: "v".repeat(43),
      expectedNonce: nonce,
      userPayload: JSON.stringify({
        name: { firstName: "Call", lastName: "Now" }
      })
    });

    expect(profile).toEqual({
      provider: "APPLE",
      subject: "apple-user-subject",
      email: "relay@privaterelay.appleid.com",
      emailVerified: true,
      displayName: "Call Now"
    });
    const tokenRequestBody = new URLSearchParams(tokenRequestBodyText);
    expect(tokenRequestBody.get("code_verifier")).toBeNull();
    expect(tokenRequestBody.get("client_secret")).toBeTruthy();
  });
});
