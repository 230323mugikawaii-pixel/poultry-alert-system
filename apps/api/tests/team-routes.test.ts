import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppEnvironment } from "../src/config/env.js";
import { AuthService } from "../src/modules/auth/auth-service.js";
import { TeamService } from "../src/modules/teams/team-service.js";
import { SecurityThrottleService } from "../src/modules/security/security-throttle-service.js";
import {
  MemoryAuthRepository,
  MemoryMagicLinkEmailSender
} from "./helpers/memory-auth.js";
import { MemoryTeamRepository } from "./helpers/memory-team.js";
import { MemorySecurityThrottleRepository } from "./helpers/memory-security-throttle.js";

const environment: AppEnvironment = {
  APP_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 8080,
  TRUST_PROXY_HOPS: 0,
  LOG_LEVEL: "silent",
  PUBLIC_ORIGIN: "https://test.call-now.example",
  COOKIE_NAME: "callnow_test_session",
  DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/test",
  AUTH_TOKEN_PEPPER: "test-token-pepper-at-least-thirty-two-characters",
  GOOGLE_OAUTH_CLIENT_ID: "test-google-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-google-client-secret",
  GOOGLE_OAUTH_REDIRECT_URI:
    "https://api.test.call-now.example/api/v1/auth/google/callback",
  GOOGLE_OAUTH_STATE_TTL_MINUTES: 10,
  GMAIL_OAUTH_CLIENT_ID: "test-gmail-client-id",
  GMAIL_OAUTH_CLIENT_SECRET: "test-gmail-client-secret",
  GMAIL_OAUTH_REDIRECT_URI:
    "https://api.test.call-now.example/api/v1/auth/gmail/callback",
  GMAIL_OAUTH_STATE_TTL_MINUTES: 10,
  GMAIL_TOKEN_ENCRYPTION_PROVIDER: "local",
  GMAIL_TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  GMAIL_TOKEN_ENCRYPTION_KEY_VERSION: "test-local-v1",
  GMAIL_KMS_KEY_NAME: "",
  MAGIC_LINK_TTL_MINUTES: 15,
  SESSION_IDLE_DAYS: 30,
  SESSION_ABSOLUTE_DAYS: 90,
  MAX_ACTIVE_SESSIONS: 5,
  INVITATION_TTL_DAYS: 30,
  JOIN_GRANT_TTL_MINUTES: 15,
  LINE_LINK_TTL_HOURS: 24,
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: 1025,
  SMTP_SECURE: false,
  SMTP_USER: "",
  SMTP_PASSWORD: "",
  EMAIL_FROM: "Call Now <test@example.com>"
};

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

interface TeamBootstrapResponse {
  readonly team: {
    readonly id: string;
    readonly role: "OWNER" | "MEMBER";
    readonly seats: {
      readonly seatLimit: number;
      readonly activeMemberCount: number;
    };
    readonly subscription: {
      readonly status: "ACTIVE" | "PAST_DUE" | "CANCELED";
    };
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("team routes", () => {
  it("bootstraps one initial team and preserves an existing member role", async () => {
    const authRepository = new MemoryAuthRepository();
    const emailSender = new MemoryMagicLinkEmailSender();
    const authService = new AuthService({
      repository: authRepository,
      emailSender,
      publicOrigin: environment.PUBLIC_ORIGIN,
      tokenPepper: environment.AUTH_TOKEN_PEPPER,
      magicLinkTtlMinutes: environment.MAGIC_LINK_TTL_MINUTES,
      sessionIdleDays: environment.SESSION_IDLE_DAYS,
      sessionAbsoluteDays: environment.SESSION_ABSOLUTE_DAYS,
      maxActiveSessions: environment.MAX_ACTIVE_SESSIONS
    });
    const owner = await login(authService, emailSender, "owner@example.com");
    const member = await login(authService, emailSender, "member@example.com");
    const teamRepository = new MemoryTeamRepository();
    const teamService = new TeamService({
      repository: teamRepository,
      now: () => new Date("2026-08-26T00:00:00.000Z"),
      teamCodeGenerator: () => "482731"
    });
    const app = await buildApp({
      environment,
      authService,
      teamService,
      securityThrottleService: new SecurityThrottleService(
        new MemorySecurityThrottleRepository(),
        environment.AUTH_TOKEN_PEPPER
      ),
      logger: false
    });
    apps.push(app);

    const bootstrap = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/teams/bootstrap",
        headers: {
          cookie: `${environment.COOKIE_NAME}=${owner.sessionToken}`,
          origin: environment.PUBLIC_ORIGIN
        },
        payload: { keywords: ["停電", "Call Now"] }
      });
    const first = await bootstrap();
    const reload = await bootstrap();
    const relogin = await bootstrap();

    expect(first.statusCode).toBe(200);
    expect(reload.statusCode).toBe(200);
    expect(relogin.statusCode).toBe(200);
    const firstPayload = first.json<TeamBootstrapResponse>();
    expect(reload.json<TeamBootstrapResponse>().team.id).toBe(
      firstPayload.team.id
    );
    expect(relogin.json<TeamBootstrapResponse>().team.id).toBe(
      firstPayload.team.id
    );
    expect(firstPayload.team).toMatchObject({
      role: "OWNER",
      seats: { seatLimit: 0, activeMemberCount: 0 },
      subscription: { status: "ACTIVE" }
    });
    expect(teamRepository.teamCreationCount).toBe(1);

    teamRepository.addMember(member.userId);
    const memberResponse = await app.inject({
      method: "POST",
      url: "/api/v1/teams/bootstrap",
      headers: {
        cookie: `${environment.COOKIE_NAME}=${member.sessionToken}`,
        origin: environment.PUBLIC_ORIGIN
      },
      payload: {}
    });
    expect(memberResponse.statusCode).toBe(200);
    expect(memberResponse.json<TeamBootstrapResponse>().team).toMatchObject({
      id: firstPayload.team.id,
      role: "MEMBER"
    });
    expect(teamRepository.teamCreationCount).toBe(1);
  });

  it("returns member details to the owner but rejects a member with 403", async () => {
    const authRepository = new MemoryAuthRepository();
    const emailSender = new MemoryMagicLinkEmailSender();
    const authService = new AuthService({
      repository: authRepository,
      emailSender,
      publicOrigin: environment.PUBLIC_ORIGIN,
      tokenPepper: environment.AUTH_TOKEN_PEPPER,
      magicLinkTtlMinutes: environment.MAGIC_LINK_TTL_MINUTES,
      sessionIdleDays: environment.SESSION_IDLE_DAYS,
      sessionAbsoluteDays: environment.SESSION_ABSOLUTE_DAYS,
      maxActiveSessions: environment.MAX_ACTIVE_SESSIONS
    });
    const owner = await login(authService, emailSender, "owner@example.com");
    const member = await login(authService, emailSender, "member@example.com");
    const teamRepository = new MemoryTeamRepository();
    const teamService = new TeamService({
      repository: teamRepository,
      teamCodeGenerator: () => "482731"
    });
    await teamService.createTeam(
      { ownerUserId: owner.userId, seatLimit: 5 },
      {
        passwordHash: "$argon2id$fixture",
        expiresAt: new Date("2026-09-23T00:00:00.000Z")
      }
    );
    teamRepository.addMember(member.userId);

    const app = await buildApp({
      environment,
      authService,
      teamService,
      securityThrottleService: new SecurityThrottleService(
        new MemorySecurityThrottleRepository(),
        environment.AUTH_TOKEN_PEPPER
      ),
      logger: false
    });
    apps.push(app);

    const ownerResponse = await app.inject({
      method: "GET",
      url: "/api/v1/teams/current/members",
      headers: { cookie: `${environment.COOKIE_NAME}=${owner.sessionToken}` }
    });
    expect(ownerResponse.statusCode).toBe(200);
    expect(ownerResponse.body).toContain("owner@example.com");

    const memberResponse = await app.inject({
      method: "GET",
      url: "/api/v1/teams/current/members",
      headers: { cookie: `${environment.COOKIE_NAME}=${member.sessionToken}` }
    });
    expect(memberResponse.statusCode).toBe(403);
    expect(memberResponse.json()).toMatchObject({
      error: { code: "OWNER_REQUIRED" }
    });
    expect(memberResponse.body).not.toContain("owner@example.com");
    expect(memberResponse.body).not.toContain("member@example.com");
  });
});

async function login(
  authService: AuthService,
  emailSender: MemoryMagicLinkEmailSender,
  email: string
): Promise<{ readonly userId: string; readonly sessionToken: string }> {
  await authService.requestMagicLink(email);
  const token = new URL(
    emailSender.messages.at(-1)?.magicLink ?? ""
  ).searchParams.get("token");
  const loginResult = await authService.consumeMagicLink(token ?? "", {});
  return {
    userId: loginResult.user.id,
    sessionToken: loginResult.sessionToken
  };
}
