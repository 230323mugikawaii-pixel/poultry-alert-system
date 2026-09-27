import { createHmac, randomBytes } from "node:crypto";
import { buildApp } from "../../src/app.js";
import { loadEnvironment } from "../../src/config/env.js";
import type { DatabaseClient } from "../../src/db/client.js";
import { AuthService } from "../../src/modules/auth/auth-service.js";
import { PrismaAuthRepository } from "../../src/modules/auth/prisma-auth-repository.js";
import { DevicePushRegistry } from "../../src/modules/device-push/device-push-registry.js";
import { LocalAesGcmTokenEncryptionProvider } from "../../src/modules/mail/token-encryption.js";
import { NotificationMemberService } from "../../src/modules/notification-members/notification-member-service.js";
import { PrismaNotificationMemberRepository } from "../../src/modules/notification-members/prisma-notification-member-repository.js";
import { notificationMemberCookieName } from "../../src/modules/notification-members/notification-member-cookie.js";
import { SecurityThrottleService } from "../../src/modules/security/security-throttle-service.js";
import { PrismaSecurityThrottleRepository } from "../../src/modules/security/prisma-security-throttle-repository.js";
import { TeamService } from "../../src/modules/teams/team-service.js";
import { PrismaTeamRepository } from "../../src/modules/teams/prisma-team-repository.js";
import { seedLedgerFixture } from "./mail-ledger-harness.js";

export const deviceEnvironment = (mode: "off" | "shadow" = "shadow") =>
  loadEnvironment({
    APP_ENV: "test",
    LOG_LEVEL: "silent",
    MOBILE_PUSH_REGISTRY_MODE: mode
  });
export const encryption = new LocalAesGcmTokenEncryptionProvider(
  randomBytes(32).toString("base64"),
  "synthetic-pr06"
);
export const makeDeviceToken = () => randomBytes(32).toString("hex");
export async function deviceFixture(db: DatabaseClient) {
  const f = await seedLedgerFixture(db);
  const env = deviceEnvironment();
  const ownerToken = randomBytes(32).toString("base64url"),
    memberToken = randomBytes(32).toString("base64url");
  const hash = (value: string) =>
    createHmac("sha256", env.AUTH_TOKEN_PEPPER).update(value).digest("hex");
  const dates = {
    idleExpiresAt: new Date(Date.now() + 3600_000),
    expiresAt: new Date(Date.now() + 3600_000)
  };
  const ownerSession = await db.session.create({
    data: { userId: f.owner.id, tokenHash: hash(ownerToken), ...dates }
  });
  const memberSession = await db.notificationMemberSession.create({
    data: {
      notificationMemberId: f.member.id,
      tokenHash: hash(memberToken),
      ...dates
    }
  });
  return {
    ...f,
    ownerSession,
    memberSession,
    ownerScope: {
      teamId: f.team.id,
      principalKind: "OWNER" as const,
      principalId: f.owner.id
    },
    memberScope: {
      teamId: f.team.id,
      principalKind: "MEMBER" as const,
      principalId: f.member.id
    },
    ownerPath: `/api/v1/teams/${f.team.id}/push-devices`,
    memberPath: "/api/v1/notification-members/push-devices",
    ownerHeaders: {
      origin: env.PUBLIC_ORIGIN,
      cookie: `${env.COOKIE_NAME}=${ownerToken}`
    },
    memberHeaders: {
      origin: env.PUBLIC_ORIGIN,
      cookie: `${notificationMemberCookieName(env)}=${memberToken}`
    }
  };
}
export function registry(db: DatabaseClient) {
  return new DevicePushRegistry(
    db,
    encryption,
    deviceEnvironment().AUTH_TOKEN_PEPPER
  );
}
export function deviceApp(
  db: DatabaseClient,
  mode: "off" | "shadow" = "shadow",
  factory?: () => DevicePushRegistry
) {
  const environment = deviceEnvironment(mode);
  const securityThrottleService = new SecurityThrottleService(
    new PrismaSecurityThrottleRepository(db),
    environment.AUTH_TOKEN_PEPPER
  );
  return buildApp({
    environment,
    logger: false,
    devicePushRegistryFactory: factory ?? (() => registry(db)),
    authService: new AuthService({
      repository: new PrismaAuthRepository(db),
      emailSender: {
        sendMagicLink: async () => {
          throw new Error("PR06_EMAIL_FORBIDDEN");
        }
      },
      publicOrigin: environment.PUBLIC_ORIGIN,
      tokenPepper: environment.AUTH_TOKEN_PEPPER,
      magicLinkTtlMinutes: 15,
      sessionIdleDays: 1,
      sessionAbsoluteDays: 1,
      maxActiveSessions: 5
    }),
    notificationMemberService: new NotificationMemberService({
      repository: new PrismaNotificationMemberRepository(db),
      securityThrottle: securityThrottleService,
      tokenPepper: environment.AUTH_TOKEN_PEPPER,
      sessionIdleDays: 1,
      sessionAbsoluteDays: 1,
      maxActiveSessions: 5
    }),
    teamService: new TeamService({ repository: new PrismaTeamRepository(db) }),
    securityThrottleService
  });
}
