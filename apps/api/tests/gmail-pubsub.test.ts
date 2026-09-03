import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnvironment } from "../src/config/env.js";
import { AppError } from "../src/lib/app-error.js";
import type { GmailMonitoringService } from "../src/modules/mail/gmail/gmail-monitoring-service.js";
import { GmailMonitoringTransientError } from "../src/modules/mail/gmail/gmail-monitoring-service.js";
import {
  GooglePubSubPushAuthenticator,
  type PubSubIdTokenVerifier,
  type PubSubPushAuthenticator
} from "../src/modules/mail/gmail/gmail-pubsub-authenticator.js";
import { parseGmailPubSubEnvelope } from "../src/modules/mail/gmail/gmail-pubsub-envelope.js";

const environment = loadEnvironment({
  APP_ENV: "test",
  LOG_LEVEL: "silent",
  PUBLIC_ORIGIN: "https://test.call-now.example",
  GMAIL_PUBSUB_MAX_BODY_BYTES: "262144"
});

describe("Pub/Sub push authentication", () => {
  const now = new Date("2026-09-03T00:00:00.000Z");
  const audience =
    "https://api.call-now.example/api/v1/webhooks/mail/google/pubsub";
  const serviceAccountEmail = "gmail-push@call-now.iam.gserviceaccount.com";

  it("accepts a signed token only for the exact audience and service account", async () => {
    const authenticator = createAuthenticator({
      iss: "https://accounts.google.com",
      aud: audience,
      exp: Math.floor(now.getTime() / 1000) + 300,
      iat: Math.floor(now.getTime() / 1000) - 10,
      email: serviceAccountEmail,
      email_verified: true
    });
    await expect(
      authenticator.authenticate(`Bearer ${"a".repeat(30)}`)
    ).resolves.toBeUndefined();
  });

  it.each([
    ["wrong audience", { aud: "https://wrong.example/push" }],
    [
      "wrong service account",
      { email: "other@call-now.iam.gserviceaccount.com" }
    ],
    ["expired token", { exp: Math.floor(now.getTime() / 1000) - 1 }],
    ["unverified email", { email_verified: false }],
    ["wrong issuer", { iss: "https://issuer.example" }]
  ])("rejects %s", async (_name, overrides) => {
    const authenticator = createAuthenticator({
      iss: "https://accounts.google.com",
      aud: audience,
      exp: Math.floor(now.getTime() / 1000) + 300,
      iat: Math.floor(now.getTime() / 1000) - 10,
      email: serviceAccountEmail,
      email_verified: true,
      ...overrides
    });
    await expect(
      authenticator.authenticate(`Bearer ${"a".repeat(30)}`)
    ).rejects.toMatchObject({ code: "GMAIL_PUBSUB_UNAUTHENTICATED" });
  });

  it("rejects a malformed or unverifiable JWT", async () => {
    const verifier: PubSubIdTokenVerifier = {
      verify: vi.fn().mockRejectedValue(new Error("invalid"))
    };
    const authenticator = new GooglePubSubPushAuthenticator({
      audience,
      serviceAccountEmail,
      verifier,
      now: () => now
    });
    await expect(
      authenticator.authenticate("Bearer not-valid")
    ).rejects.toMatchObject({ code: "GMAIL_PUBSUB_UNAUTHENTICATED" });
    await expect(
      authenticator.authenticate(`Bearer ${"x".repeat(30)}`)
    ).rejects.toMatchObject({ code: "GMAIL_PUBSUB_UNAUTHENTICATED" });
  });

  function createAuthenticator(overrides: Record<string, unknown>) {
    const verifier: PubSubIdTokenVerifier = {
      verify: vi.fn().mockResolvedValue(overrides)
    };
    return new GooglePubSubPushAuthenticator({
      audience,
      serviceAccountEmail,
      verifier,
      now: () => now
    });
  }
});

describe("Pub/Sub envelope", () => {
  it("strictly decodes the Gmail notification", () => {
    expect(parseGmailPubSubEnvelope(envelope())).toMatchObject({
      messageId: "pubsub-message-1",
      emailAddress: "monitor@example.com",
      historyId: "90071992547409930001"
    });
  });

  it.each([
    ["invalid base64", envelope("not@base64")],
    ["invalid JSON", envelope(Buffer.from("{").toString("base64"))],
    [
      "empty history",
      envelope(
        Buffer.from(
          JSON.stringify({ emailAddress: "monitor@example.com", historyId: "" })
        ).toString("base64")
      )
    ],
    [
      "invalid email",
      envelope(
        Buffer.from(
          JSON.stringify({ emailAddress: "invalid", historyId: "10" })
        ).toString("base64")
      )
    ],
    [
      "oversized decoded payload",
      envelope(Buffer.alloc(8_193, 1).toString("base64"))
    ],
    ["unknown envelope property", { ...envelope(), unexpected: true }]
  ])("rejects %s", (_name, value) => {
    expect(() => parseGmailPubSubEnvelope(value)).toThrow();
  });
});

describe("Gmail Pub/Sub route", () => {
  it("accepts an authenticated JSON push and returns 204", async () => {
    const processPushNotification = vi.fn().mockResolvedValue(undefined);
    const app = await buildApp({
      environment,
      logger: false,
      gmailMonitoringService: {
        processPushNotification
      } as unknown as GmailMonitoringService,
      gmailPubSubAuthenticator: {
        authenticate: vi.fn().mockResolvedValue(undefined)
      }
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/mail/google/pubsub",
      headers: {
        authorization: `Bearer ${"a".repeat(30)}`,
        "content-type": "application/json"
      },
      payload: envelope()
    });
    expect(response.statusCode).toBe(204);
    expect(processPushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAddress: "monitor@example.com",
        historyId: "90071992547409930001"
      })
    );
    await app.close();
  });

  it("returns 401 for unauthenticated pushes and 503 for transient processing", async () => {
    const rejectingAuthenticator: PubSubPushAuthenticator = {
      authenticate: vi
        .fn()
        .mockRejectedValue(
          new AppError(
            "GMAIL_PUBSUB_UNAUTHENTICATED",
            "The push request could not be authenticated.",
            401
          )
        )
    };
    const first = await buildApp({
      environment,
      logger: false,
      gmailMonitoringService: {
        processPushNotification: vi.fn()
      } as unknown as GmailMonitoringService,
      gmailPubSubAuthenticator: rejectingAuthenticator
    });
    expect(
      (
        await first.inject({
          method: "POST",
          url: "/api/v1/webhooks/mail/google/pubsub",
          headers: { "content-type": "application/json" },
          payload: envelope()
        })
      ).statusCode
    ).toBe(401);
    await first.close();

    const second = await buildApp({
      environment,
      logger: false,
      gmailMonitoringService: {
        processPushNotification: vi
          .fn()
          .mockRejectedValue(
            new GmailMonitoringTransientError("GMAIL_NETWORK_ERROR")
          )
      } as unknown as GmailMonitoringService,
      gmailPubSubAuthenticator: {
        authenticate: vi.fn().mockResolvedValue(undefined)
      }
    });
    expect(
      (
        await second.inject({
          method: "POST",
          url: "/api/v1/webhooks/mail/google/pubsub",
          headers: {
            authorization: `Bearer ${"a".repeat(30)}`,
            "content-type": "application/json"
          },
          payload: envelope()
        })
      ).statusCode
    ).toBe(503);
    await second.close();
  });

  it("rejects the wrong content type without processing", async () => {
    const processPushNotification = vi.fn();
    const app = await buildApp({
      environment,
      logger: false,
      gmailMonitoringService: {
        processPushNotification
      } as unknown as GmailMonitoringService,
      gmailPubSubAuthenticator: {
        authenticate: vi.fn().mockResolvedValue(undefined)
      }
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/mail/google/pubsub",
      headers: { "content-type": "text/plain" },
      payload: "not-json"
    });
    expect(response.statusCode).toBe(415);
    expect(processPushNotification).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an oversized HTTP request body before processing", async () => {
    const processPushNotification = vi.fn();
    const smallEnvironment = loadEnvironment({
      APP_ENV: "test",
      LOG_LEVEL: "silent",
      PUBLIC_ORIGIN: "https://test.call-now.example",
      GMAIL_PUBSUB_MAX_BODY_BYTES: "16384"
    });
    const app = await buildApp({
      environment: smallEnvironment,
      logger: false,
      gmailMonitoringService: {
        processPushNotification
      } as unknown as GmailMonitoringService,
      gmailPubSubAuthenticator: {
        authenticate: vi.fn().mockResolvedValue(undefined)
      }
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/mail/google/pubsub",
      headers: {
        authorization: `Bearer ${"a".repeat(30)}`,
        "content-type": "application/json"
      },
      payload: { padding: "x".repeat(20_000) }
    });
    expect(response.statusCode).toBe(413);
    expect(processPushNotification).not.toHaveBeenCalled();
    await app.close();
  });
});

function envelope(data?: string) {
  return {
    message: {
      messageId: "pubsub-message-1",
      publishTime: "2026-09-03T00:00:00.000Z",
      data:
        data ??
        Buffer.from(
          JSON.stringify({
            emailAddress: "MONITOR@example.com",
            historyId: "90071992547409930001"
          })
        ).toString("base64")
    },
    subscription: "projects/call-now/subscriptions/gmail-push"
  };
}
