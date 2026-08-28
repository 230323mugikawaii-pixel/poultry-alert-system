import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../src/db/client.js";
import { AppError } from "../src/lib/app-error.js";
import { AlertService } from "../src/modules/alerts/alert-service.js";
import { PrismaAlertRepository } from "../src/modules/alerts/prisma-alert-repository.js";
import { AuthService } from "../src/modules/auth/auth-service.js";
import { GoogleAuthService } from "../src/modules/auth/google-auth-service.js";
import type {
  GoogleIdentityProfile,
  GoogleOAuthProvider
} from "../src/modules/auth/google-oauth-client.js";
import { PrismaAuthRepository } from "../src/modules/auth/prisma-auth-repository.js";
import type {
  PrimaryAuthProviderAdapter,
  PrimaryIdentityProfile
} from "../src/modules/auth/primary-auth-provider.js";
import { PrimaryAuthService } from "../src/modules/auth/primary-auth-service.js";
import { MailConnectionService } from "../src/modules/mail/mail-connection-service.js";
import type {
  MailOAuthGrant,
  MailProviderAdapter
} from "../src/modules/mail/mail-provider.js";
import { GMAIL_READONLY_SCOPE } from "../src/modules/mail/providers/google-mail-provider.js";
import { PrismaMailConnectionRepository } from "../src/modules/mail/prisma-mail-connection-repository.js";
import { NotificationMemberService } from "../src/modules/notification-members/notification-member-service.js";
import { PrismaNotificationMemberRepository } from "../src/modules/notification-members/prisma-notification-member-repository.js";
import { LocalAesGcmTokenEncryptionProvider } from "../src/modules/mail/token-encryption.js";
import { InvitationService } from "../src/modules/invitations/invitation-service.js";
import { prepareInvitationCredential } from "../src/modules/invitations/invitation-credential.js";
import { PrismaInvitationRepository } from "../src/modules/invitations/prisma-invitation-repository.js";
import { PaidSeatIncreaseService } from "../src/modules/teams/paid-seat-increase-service.js";
import { PrismaTeamRepository } from "../src/modules/teams/prisma-team-repository.js";
import { PrismaSecurityThrottleRepository } from "../src/modules/security/prisma-security-throttle-repository.js";
import { SecurityThrottleService } from "../src/modules/security/security-throttle-service.js";
import { TeamService } from "../src/modules/teams/team-service.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const postgresDescribe =
  process.env.RUN_POSTGRES_TESTS === "true" ? describe : describe.skip;

let database: DatabaseClient;
const testPepper = "postgres-acceptance-pepper-at-least-thirty-two-characters";

postgresDescribe("PostgreSQL concurrent invitation redemption", () => {
  beforeAll(async () => {
    assertDedicatedTestDatabase(databaseUrl);
    database = createDatabaseClient(databaseUrl);
    await database.$queryRaw`SELECT 1`;
  });

  beforeEach(async () => {
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE
        audit_events,
        alert_recipients,
        alerts,
        notification_member_sessions,
        notification_members,
        external_identities,
        invitation_redemptions,
        invitation_links,
        auth_challenges,
        invitations,
        notification_targets,
        sessions,
        devices,
        subscription_changes,
        team_keywords,
        subscriptions,
        team_memberships,
        mail_connections,
        mail_authorizations,
        owner_transfers,
        auth_credentials,
        teams,
        users,
        security_throttles
      CASCADE
    `);
  });

  afterAll(async () => {
    await database?.$disconnect();
  });

  it("persists a Google identity and creates a one-use Phase 1 session", async () => {
    const repository = new PrismaAuthRepository(database);
    const authService = new AuthService({
      repository,
      emailSender: { sendMagicLink: async () => undefined },
      publicOrigin: "https://acceptance.call-now.example",
      tokenPepper: testPepper,
      magicLinkTtlMinutes: 15,
      sessionIdleDays: 30,
      sessionAbsoluteDays: 90,
      maxActiveSessions: 5
    });
    const googleAuthService = new GoogleAuthService({
      repository,
      authService,
      oauthProvider: new PostgresGoogleOAuthProvider(),
      tokenPepper: testPepper,
      stateTtlMinutes: 10
    });

    const authorization = await googleAuthService.createAuthorizationRequest();
    const login = await googleAuthService.completeAuthorization(
      authorization.state,
      "postgres-google-code",
      { ipAddress: "198.51.100.1", userAgent: "Acceptance Test" }
    );

    await expect(
      authService.authenticate(login.sessionToken)
    ).resolves.toMatchObject({
      user: { email: "postgres-google@example.com" }
    });
    await expect(
      database.externalIdentity.findUnique({
        where: {
          provider_providerSubject: {
            provider: "GOOGLE",
            providerSubject: "postgres-google-subject"
          }
        },
        select: {
          userId: true,
          email: true,
          emailVerified: true,
          revokedAt: true
        }
      })
    ).resolves.toEqual({
      userId: login.user.id,
      email: "postgres-google@example.com",
      emailVerified: true,
      revokedAt: null
    });
    await expect(
      googleAuthService.completeAuthorization(
        authorization.state,
        "postgres-google-code",
        {}
      )
    ).rejects.toMatchObject({
      code: "GOOGLE_LOGIN_INVALID_OR_EXPIRED",
      statusCode: 401
    });
  });

  it("links primary providers by subject without email-only account merging", async () => {
    const repository = new PrismaAuthRepository(database);
    const authService = new AuthService({
      repository,
      emailSender: { sendMagicLink: async () => undefined },
      publicOrigin: "https://acceptance.call-now.example",
      tokenPepper: testPepper,
      magicLinkTtlMinutes: 15,
      sessionIdleDays: 30,
      sessionAbsoluteDays: 90,
      maxActiveSessions: 5
    });
    const service = new PrimaryAuthService({
      repository,
      authService,
      providerAdapters: [
        new PostgresPrimaryOAuthProvider(
          "GOOGLE",
          "primary-google-subject",
          "primary@example.com"
        ),
        new PostgresPrimaryOAuthProvider(
          "MICROSOFT",
          "tenant:primary-microsoft-subject",
          "primary@example.com"
        )
      ],
      tokenPepper: testPepper,
      stateTtlMinutes: { GOOGLE: 10, MICROSOFT: 10, APPLE: 10 }
    });
    const googleLogin = await completePrimaryLogin(service, "GOOGLE");

    await expect(
      completePrimaryLogin(service, "MICROSOFT")
    ).rejects.toMatchObject({ code: "LOGIN_IDENTITY_LINK_REQUIRED" });

    const linkRequest = await service.createAuthorizationRequest({
      provider: "MICROSOFT",
      intent: "LINK",
      authenticatedUserId: googleLogin.user.id
    });
    await service.completeAuthorization({
      provider: "MICROSOFT",
      state: linkRequest.state,
      code: "postgres-primary-code",
      authenticatedUserId: googleLogin.user.id,
      clientContext: { ipAddress: "127.0.0.1", userAgent: "Postgres test" }
    });

    await expect(
      database.externalIdentity.count({
        where: { userId: googleLogin.user.id, revokedAt: null }
      })
    ).resolves.toBe(2);

    const unlinkAttempts = await Promise.allSettled([
      service.unlinkIdentity(googleLogin.user.id, "GOOGLE"),
      service.unlinkIdentity(googleLogin.user.id, "MICROSOFT")
    ]);
    expect(
      unlinkAttempts.filter(({ status }) => status === "fulfilled")
    ).toHaveLength(1);
    expect(
      unlinkAttempts.filter(({ status }) => status === "rejected")
    ).toHaveLength(1);
    await expect(
      database.externalIdentity.count({
        where: { userId: googleLogin.user.id, revokedAt: null }
      })
    ).resolves.toBe(1);
  });

  it("bootstraps one initial team under concurrency and preserves member roles", async () => {
    const newUser = await createUser("bootstrap-owner@example.com");
    const clock = { value: new Date("2026-08-26T00:00:00.000Z") };
    const bootstrapServices = ["482741", "482742", "482743"].map(
      (teamCode) => createServices(clock, teamCode).teamService
    );

    const concurrent = await Promise.all(
      bootstrapServices.map((service) =>
        service.ensureInitialTeamForUser({
          userId: newUser.id,
          keywords: ["停電", "Call Now"]
        })
      )
    );
    const initialTeamId = concurrent[0]?.teamId;
    expect(initialTeamId).toBeDefined();
    expect(new Set(concurrent.map(({ teamId }) => teamId))).toEqual(
      new Set([initialTeamId])
    );
    expect(concurrent.every(({ role }) => role === "OWNER")).toBe(true);
    await expect(
      database.teamMembership.count({ where: { userId: newUser.id } })
    ).resolves.toBe(1);
    await expect(
      database.team.count({
        where: { memberships: { some: { userId: newUser.id } } }
      })
    ).resolves.toBe(1);

    const repeated = await Promise.all(
      bootstrapServices.map((service) =>
        service.ensureInitialTeamForUser({ userId: newUser.id })
      )
    );
    expect(repeated.every(({ teamId }) => teamId === initialTeamId)).toBe(true);
    await expect(
      database.teamMembership.count({ where: { userId: newUser.id } })
    ).resolves.toBe(1);

    const existingOwner = await createUser(
      "bootstrap-existing-owner@example.com"
    );
    const existingMember = await createUser(
      "bootstrap-existing-member@example.com"
    );
    const existing = await createServices(
      clock,
      "482744"
    ).teamService.createTeam({
      ownerUserId: existingOwner.id,
      seatLimit: 0
    });
    await database.teamMembership.create({
      data: {
        teamId: existing.team.teamId,
        userId: existingMember.id,
        role: "MEMBER",
        status: "ACTIVE"
      }
    });

    const preserved = await createServices(
      clock,
      "482745"
    ).teamService.ensureInitialTeamForUser({ userId: existingMember.id });
    expect(preserved).toMatchObject({
      teamId: existing.team.teamId,
      role: "MEMBER"
    });
    await expect(
      database.teamMembership.count({
        where: { userId: existingMember.id, role: "OWNER" }
      })
    ).resolves.toBe(0);
    await expect(
      database.teamMembership.count({ where: { userId: existingMember.id } })
    ).resolves.toBe(1);
  });

  it("stores a Gmail monitoring grant encrypted and revokes it on disconnect", async () => {
    const owner = await createUser("gmail-owner@example.com");
    const services = createServices(
      { value: new Date("2026-08-26T00:00:00.000Z") },
      "482738"
    );
    const created = await services.teamService.createTeam({
      ownerUserId: owner.id,
      seatLimit: 0
    });
    const provider = new PostgresMailProviderAdapter();
    const encryption = new LocalAesGcmTokenEncryptionProvider(
      Buffer.alloc(32, 7).toString("base64"),
      "postgres-test-v1"
    );
    const gmailService = new MailConnectionService({
      repository: new PrismaMailConnectionRepository(database),
      providerAdapters: [
        provider,
        new PostgresMailProviderAdapter("MICROSOFT")
      ],
      tokenEncryption: encryption,
      tokenPepper: testPepper,
      stateTtlMinutes: { GOOGLE: 10, MICROSOFT: 10 },
      now: () => new Date("2026-08-26T00:00:00.000Z")
    });

    const authorization = await gmailService.createAuthorizationRequest(
      owner.id,
      created.team.teamId,
      "CONNECT",
      "GOOGLE"
    );
    const connected = await gmailService.completeAuthorization({
      provider: "GOOGLE",
      state: authorization.state,
      code: "postgres-gmail-code",
      authenticatedUserId: owner.id,
      requestId: "postgres-gmail-connect"
    });

    expect(connected).toMatchObject({
      teamId: created.team.teamId,
      email: "monitoring-postgres@example.com",
      authorizationStatus: "ACTIVE",
      connectionStatus: "ACTIVE"
    });
    const stored = await database.mailAuthorization.findFirstOrThrow({
      where: { userId: owner.id }
    });
    expect(stored.encryptedRefreshToken).not.toContain(
      PostgresMailProviderAdapter.refreshToken
    );
    expect(stored).toMatchObject({
      provider: "GOOGLE",
      providerSubject: "postgres-gmail-subject",
      encryptionProvider: "LOCAL_AES_256_GCM",
      encryptionKeyVersion: "postgres-test-v1",
      status: "ACTIVE"
    });
    await expect(
      encryption.decrypt({
        ciphertext: stored.encryptedRefreshToken ?? "",
        provider: stored.encryptionProvider ?? "",
        keyVersion: stored.encryptionKeyVersion ?? ""
      })
    ).resolves.toBe(PostgresMailProviderAdapter.refreshToken);
    await expect(
      gmailService.completeAuthorization({
        provider: "GOOGLE",
        state: authorization.state,
        code: "postgres-gmail-code",
        authenticatedUserId: owner.id
      })
    ).rejects.toMatchObject({
      code: "MAIL_AUTHORIZATION_INVALID_OR_EXPIRED",
      statusCode: 401
    });

    await gmailService.disconnect({
      teamId: created.team.teamId,
      ownerUserId: owner.id,
      requestId: "postgres-gmail-disconnect"
    });
    await expect(
      database.mailAuthorization.findFirstOrThrow({
        where: { userId: owner.id },
        select: { status: true, encryptedRefreshToken: true }
      })
    ).resolves.toEqual({ status: "REVOKED", encryptedRefreshToken: null });
    await expect(
      database.mailConnection.findFirstOrThrow({
        where: { teamId: created.team.teamId },
        select: { status: true }
      })
    ).resolves.toEqual({ status: "REVOKED" });
    expect(provider.revokedTokens).toContain(
      PostgresMailProviderAdapter.refreshToken
    );
    const auditActions = await database.auditEvent.findMany({
      where: { teamId: created.team.teamId },
      select: { action: true }
    });
    expect(auditActions).toHaveLength(4);
    expect(auditActions).toEqual(
      expect.arrayContaining([
        { action: "TEAM_CREATED" },
        { action: "MAIL_CONNECTED" },
        { action: "MAIL_AUTHORIZATION_REVOKED" },
        { action: "MAIL_CONNECTION_DISCONNECTED" }
      ])
    );
  });

  it("shares one Gmail authorization across owned teams and revokes only after the last disconnect", async () => {
    const owner = await createUser("gmail-multi-team-owner@example.com");
    const clock = { value: new Date("2026-08-26T00:30:00.000Z") };
    const first = await createServices(clock, "482739").teamService.createTeam({
      ownerUserId: owner.id,
      seatLimit: 0
    });
    const second = await createServices(clock, "482740").teamService.createTeam(
      {
        ownerUserId: owner.id,
        seatLimit: 0
      }
    );
    const provider = new PostgresMailProviderAdapter();
    const gmailService = new MailConnectionService({
      repository: new PrismaMailConnectionRepository(database),
      providerAdapters: [
        provider,
        new PostgresMailProviderAdapter("MICROSOFT")
      ],
      tokenEncryption: new LocalAesGcmTokenEncryptionProvider(
        Buffer.alloc(32, 8).toString("base64"),
        "postgres-multi-team-v1"
      ),
      tokenPepper: testPepper,
      stateTtlMinutes: { GOOGLE: 10, MICROSOFT: 10 },
      now: () => clock.value
    });

    for (const teamId of [first.team.teamId, second.team.teamId]) {
      const authorization = await gmailService.createAuthorizationRequest(
        owner.id,
        teamId,
        "CONNECT",
        "GOOGLE"
      );
      await gmailService.completeAuthorization({
        provider: "GOOGLE",
        state: authorization.state,
        code: "postgres-gmail-code",
        authenticatedUserId: owner.id
      });
    }

    await expect(
      database.mailAuthorization.count({ where: { userId: owner.id } })
    ).resolves.toBe(1);
    await expect(
      database.mailConnection.count({
        where: {
          teamId: { in: [first.team.teamId, second.team.teamId] },
          status: "ACTIVE"
        }
      })
    ).resolves.toBe(2);

    const sharedAuthorization =
      await database.mailAuthorization.findFirstOrThrow({
        where: { userId: owner.id },
        select: { id: true }
      });
    await gmailService.markProviderFailure({
      authorizationId: sharedAuthorization.id,
      provider: "GOOGLE",
      error: { code: "invalid_grant" }
    });
    await expect(
      database.mailConnection.count({
        where: {
          teamId: { in: [first.team.teamId, second.team.teamId] },
          status: "REAUTH_REQUIRED"
        }
      })
    ).resolves.toBe(2);

    const reauthorization = await gmailService.createAuthorizationRequest(
      owner.id,
      first.team.teamId,
      "REAUTHORIZE",
      "GOOGLE",
      (
        await database.mailConnection.findFirstOrThrow({
          where: { teamId: first.team.teamId },
          select: { id: true }
        })
      ).id
    );
    await gmailService.completeAuthorization({
      provider: "GOOGLE",
      state: reauthorization.state,
      code: "postgres-gmail-code",
      authenticatedUserId: owner.id
    });
    await expect(
      database.mailConnection.count({
        where: {
          teamId: { in: [first.team.teamId, second.team.teamId] },
          status: "ACTIVE"
        }
      })
    ).resolves.toBe(2);

    await gmailService.disconnect({
      teamId: first.team.teamId,
      ownerUserId: owner.id
    });
    const retainedAuthorization =
      await database.mailAuthorization.findFirstOrThrow({
        where: { userId: owner.id },
        select: { status: true, encryptedRefreshToken: true }
      });
    expect(retainedAuthorization.status).toBe("ACTIVE");
    expect(retainedAuthorization.encryptedRefreshToken).not.toBeNull();
    expect(provider.revokedTokens).toHaveLength(0);

    await gmailService.disconnect({
      teamId: second.team.teamId,
      ownerUserId: owner.id
    });
    await expect(
      database.mailAuthorization.findFirstOrThrow({
        where: { userId: owner.id },
        select: { status: true, encryptedRefreshToken: true }
      })
    ).resolves.toEqual({ status: "REVOKED", encryptedRefreshToken: null });
    expect(provider.revokedTokens).toEqual([
      PostgresMailProviderAdapter.refreshToken
    ]);
  });

  it("keeps Google and Microsoft monitoring connections active at the same time", async () => {
    const owner = await createUser("provider-switch-owner@example.com");
    const clock = { value: new Date("2026-08-26T01:00:00.000Z") };
    const created = await createServices(
      clock,
      "482741"
    ).teamService.createTeam({
      ownerUserId: owner.id,
      seatLimit: 0
    });
    const google = new PostgresMailProviderAdapter("GOOGLE");
    const microsoft = new PostgresMailProviderAdapter("MICROSOFT");
    const encryption = new LocalAesGcmTokenEncryptionProvider(
      Buffer.alloc(32, 9).toString("base64"),
      "postgres-provider-switch-v1"
    );
    const mailService = new MailConnectionService({
      repository: new PrismaMailConnectionRepository(database),
      providerAdapters: [google, microsoft],
      tokenEncryption: encryption,
      tokenPepper: testPepper,
      stateTtlMinutes: { GOOGLE: 10, MICROSOFT: 10 },
      now: () => clock.value
    });

    const googleAuthorization = await mailService.createAuthorizationRequest(
      owner.id,
      created.team.teamId,
      "CONNECT",
      "GOOGLE"
    );
    await mailService.completeAuthorization({
      provider: "GOOGLE",
      state: googleAuthorization.state,
      code: "postgres-gmail-code",
      authenticatedUserId: owner.id
    });
    const microsoftAuthorization = await mailService.createAuthorizationRequest(
      owner.id,
      created.team.teamId,
      "CONNECT",
      "MICROSOFT"
    );
    await expect(
      database.mailAuthorization.findFirstOrThrow({
        where: { userId: owner.id },
        select: { provider: true, status: true }
      })
    ).resolves.toEqual({ provider: "GOOGLE", status: "ACTIVE" });
    await mailService.completeAuthorization({
      provider: "MICROSOFT",
      state: microsoftAuthorization.state,
      code: "postgres-microsoft-code",
      authenticatedUserId: owner.id
    });

    await expect(
      database.mailAuthorization.count({ where: { userId: owner.id } })
    ).resolves.toBe(2);
    const stored = await database.mailAuthorization.findMany({
      where: { userId: owner.id },
      include: { connections: true },
      orderBy: { provider: "asc" }
    });
    expect(stored).toHaveLength(2);
    expect(
      stored.map(({ provider, status }) => ({ provider, status }))
    ).toEqual(
      expect.arrayContaining([
        { provider: "GOOGLE", status: "ACTIVE" },
        { provider: "MICROSOFT", status: "ACTIVE" }
      ])
    );
    expect(stored.flatMap(({ connections }) => connections)).toHaveLength(2);
    const microsoftStored = stored.find(
      ({ provider }) => provider === "MICROSOFT"
    );
    expect(microsoftStored?.encryptedRefreshToken).not.toContain(
      microsoft.refreshToken
    );
    await expect(
      encryption.decrypt({
        ciphertext: microsoftStored?.encryptedRefreshToken ?? "",
        provider: microsoftStored?.encryptionProvider ?? "",
        keyVersion: microsoftStored?.encryptionKeyVersion ?? ""
      })
    ).resolves.toBe(microsoft.refreshToken);
    const googleStored = stored.find(({ provider }) => provider === "GOOGLE");
    const googleConnectionId = googleStored?.connections[0]?.id;
    expect(googleConnectionId).toBeDefined();
    if (!googleStored || !googleConnectionId || !microsoftStored) {
      throw new Error("mail_connection_fixture_missing");
    }
    await mailService.disconnect({
      teamId: created.team.teamId,
      ownerUserId: owner.id,
      connectionId: googleConnectionId
    });
    await expect(
      database.mailConnection.count({
        where: { teamId: created.team.teamId, status: "ACTIVE" }
      })
    ).resolves.toBe(1);
    await expect(
      database.mailAuthorization.findFirstOrThrow({
        where: { id: googleStored.id },
        select: { status: true, encryptedRefreshToken: true }
      })
    ).resolves.toEqual({ status: "REVOKED", encryptedRefreshToken: null });
    await expect(
      database.mailAuthorization.findFirstOrThrow({
        where: { id: microsoftStored.id },
        select: { status: true, encryptedRefreshToken: true }
      })
    ).resolves.toMatchObject({ status: "ACTIVE" });
    expect(google.revokedTokens).toEqual([google.refreshToken]);
    expect(microsoft.revokedTokens).toEqual([]);
  });

  it("admits only five members to five seats and returns 409 for the loser", async () => {
    const users = await Promise.all(
      Array.from({ length: 7 }, (_, index) =>
        database.user.create({
          data: {
            email: `postgres-acceptance-${index}@example.com`,
            emailVerifiedAt: new Date()
          }
        })
      )
    );
    const owner = users[0];
    const members = users.slice(1);
    expect(owner).toBeDefined();

    const teamService = new TeamService({
      repository: new PrismaTeamRepository(database),
      teamCodeGenerator: () => "482731"
    });
    const initialCredential = await prepareInvitationCredential({
      now: new Date(),
      ttlDays: 30
    });
    const { team } = await teamService.createTeam(
      {
        ownerUserId: owner?.id ?? "",
        seatLimit: 5
      },
      initialCredential
    );
    const invitationService = new InvitationService({
      repository: new PrismaInvitationRepository(database),
      teamService,
      publicOrigin: "https://acceptance.call-now.example",
      tokenPepper: "postgres-acceptance-pepper-at-least-thirty-two-characters",
      invitationTtlDays: 30,
      joinGrantTtlMinutes: 15,
      lineLinkTtlHours: 24,
      securityThrottle: new SecurityThrottleService(
        new PrismaSecurityThrottleRepository(database),
        "postgres-acceptance-pepper-at-least-thirty-two-characters"
      )
    });
    const issued = await invitationService.issueForTeam(
      team.teamId,
      owner?.id ?? ""
    );
    const grants = await Promise.all(
      members.map((_, index) =>
        invitationService.verifyPasswordInvitation({
          teamCode: team.teamCode,
          password: issued.password,
          attemptKey: `198.51.100.${index + 1}`
        })
      )
    );

    const attempts = await Promise.allSettled(
      members.map((member, index) =>
        invitationService.completeJoin({
          userId: member.id,
          joinToken: grants[index]?.joinToken ?? "",
          idempotencyKey: randomUUID()
        })
      )
    );
    const fulfilled = attempts.filter(
      (attempt) => attempt.status === "fulfilled"
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected"
    );

    expect(fulfilled).toHaveLength(5);
    expect(rejected).toHaveLength(1);
    const rejection: unknown = rejected[0]?.reason;
    expect(rejection).toBeInstanceOf(AppError);
    if (!(rejection instanceof AppError)) {
      throw new Error("Expected the rejected join to return an AppError");
    }
    expect(rejection).toMatchObject({ statusCode: 409 });
    expect(["INVITATION_EXHAUSTED", "JOIN_TRANSACTION_CONFLICT"]).toContain(
      rejection.code
    );

    await expect(
      database.teamMembership.count({
        where: { teamId: team.teamId, role: "MEMBER", status: "ACTIVE" }
      })
    ).resolves.toBe(5);
    await expect(
      database.invitation.findUnique({
        where: { id: issued.invitation.id },
        select: { status: true, maxUses: true, usedCount: true }
      })
    ).resolves.toEqual({ status: "EXHAUSTED", maxUses: 5, usedCount: 5 });
  });

  it("applies a paid 5-to-6 increase once and issues exactly one new seat", async () => {
    const clock = { value: new Date("2026-08-24T00:00:00.000Z") };
    const owner = await createUser("paid-owner@example.com");
    const services = createServices(clock, "482732");
    const initialCredential = await prepareInvitationCredential({
      now: clock.value,
      ttlDays: 30
    });
    const created = await services.teamService.createTeam(
      { ownerUserId: owner.id, seatLimit: 5 },
      initialCredential
    );
    expect(created.invitation).toMatchObject({ maxUses: 5, usedCount: 0 });
    const line = await services.invitationService.createLineInvitationLink(
      owner.id,
      created.invitation?.id
    );

    const members = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        createUser(`paid-member-${index}@example.com`)
      )
    );
    await database.teamMembership.createMany({
      data: members.map((member) => ({
        teamId: created.team.teamId,
        userId: member.id,
        role: "MEMBER" as const,
        status: "ACTIVE" as const
      }))
    });
    const requested = await services.teamService.requestSeatLimitChange(
      owner.id,
      6
    );
    expect(requested).toMatchObject({
      status: "AWAITING_PAYMENT",
      activeMemberCount: 5,
      availableSeats: 0,
      invitation: null
    });

    const paidService = new PaidSeatIncreaseService({
      repository: services.teamRepository,
      tokenPepper: testPepper,
      invitationTtlDays: 30,
      now: () => clock.value
    });
    const results = await Promise.all([
      paidService.apply({
        changeId: requested.changeId,
        paymentEventId: "payment-event-5-to-6"
      }),
      paidService.apply({
        changeId: requested.changeId,
        paymentEventId: "payment-event-5-to-6"
      })
    ]);

    expect(results[0]).toMatchObject({
      status: "APPLIED",
      availableSeats: 1,
      invitation: { maxUses: 1, usedCount: 0 }
    });
    expect(results[1]?.invitation?.id).toBe(results[0]?.invitation?.id);
    expect(results[1]?.invitationPassword).toBe(results[0]?.invitationPassword);
    await expect(
      paidService.apply({
        changeId: requested.changeId,
        paymentEventId: "payment-event-different"
      })
    ).rejects.toMatchObject({
      code: "PAYMENT_EVENT_CONFLICT",
      statusCode: 409
    });

    await expect(
      database.subscription.findUnique({
        where: { teamId: created.team.teamId },
        select: { seatLimit: true, currentTermAmountYen: true }
      })
    ).resolves.toEqual({ seatLimit: 6, currentTermAmountYen: 6600 });
    await expect(
      database.invitation.findMany({
        where: { teamId: created.team.teamId },
        orderBy: { createdAt: "asc" },
        select: { id: true, status: true, maxUses: true }
      })
    ).resolves.toEqual([
      {
        id: created.invitation?.id,
        status: "REPLACED",
        maxUses: 5
      },
      {
        id: results[0]?.invitation?.id,
        status: "ACTIVE",
        maxUses: 1
      }
    ]);
    const lineId = line.linkId;
    await expect(
      database.invitationLink.findUnique({
        where: { id: lineId },
        select: { status: true }
      })
    ).resolves.toEqual({ status: "REPLACED" });
  });

  it("holds an unsafe reduction and disables removed member access atomically", async () => {
    const clock = { value: new Date("2026-08-24T01:00:00.000Z") };
    const owner = await createUser("reduction-owner@example.com");
    const services = createServices(clock, "482733");
    const initialCredential = await prepareInvitationCredential({
      now: clock.value,
      ttlDays: 30
    });
    const created = await services.teamService.createTeam(
      { ownerUserId: owner.id, seatLimit: 6 },
      initialCredential
    );
    await services.invitationService.createLineInvitationLink(
      owner.id,
      created.invitation?.id
    );
    const members = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        createUser(`reduction-member-${index}@example.com`)
      )
    );
    await database.teamMembership.createMany({
      data: members.map((member) => ({
        teamId: created.team.teamId,
        userId: member.id,
        role: "MEMBER" as const,
        status: "ACTIVE" as const
      }))
    });
    const targetMembership = await database.teamMembership.findUniqueOrThrow({
      where: {
        teamId_userId: {
          teamId: created.team.teamId,
          userId: members[0]?.id ?? ""
        }
      }
    });
    await database.session.create({
      data: {
        userId: targetMembership.userId,
        tokenHash: "a".repeat(64),
        idleExpiresAt: new Date("2026-09-24T00:00:00.000Z"),
        expiresAt: new Date("2026-11-24T00:00:00.000Z")
      }
    });
    await database.notificationTarget.create({
      data: {
        membershipId: targetMembership.id,
        channel: "WEB_PUSH",
        endpointCiphertext: "encrypted-endpoint",
        endpointHash: "b".repeat(64),
        verifiedAt: clock.value
      }
    });

    const pending = await services.teamService.requestSeatLimitChange(
      owner.id,
      5
    );
    expect(pending).toMatchObject({
      status: "PENDING_CAPACITY",
      activeMemberCount: 6,
      availableSeats: 0
    });
    await expect(
      database.invitationLink.findFirst({
        where: { invitationId: created.invitation?.id ?? "" },
        select: { status: true }
      })
    ).resolves.toEqual({ status: "REVOKED" });

    const removed = await services.invitationService.removeMember(
      owner.id,
      targetMembership.id
    );
    expect(removed).toMatchObject({
      activeMemberCount: 5,
      seatLimit: 5,
      availableSeats: 0,
      pendingSeatLimitApplied: true,
      invitation: null,
      invitationPassword: null
    });
    await expect(
      database.subscription.findUnique({
        where: { teamId: created.team.teamId },
        select: { seatLimit: true, pendingSeatLimit: true }
      })
    ).resolves.toEqual({ seatLimit: 5, pendingSeatLimit: null });
    await expect(
      database.session.findFirst({
        where: { userId: targetMembership.userId },
        select: { revokedAt: true }
      })
    ).resolves.toEqual({ revokedAt: clock.value });
    await expect(
      database.notificationTarget.findFirst({
        where: { membershipId: targetMembership.id },
        select: { status: true, disabledAt: true }
      })
    ).resolves.toEqual({ status: "DISABLED", disabledAt: clock.value });
  });

  it("applies a safe reduction and replaces its capacity invitation in one transaction", async () => {
    const clock = { value: new Date("2026-08-24T01:30:00.000Z") };
    const owner = await createUser("safe-reduction-owner@example.com");
    const services = createServices(clock, "482737");
    const initialCredential = await prepareInvitationCredential({
      now: clock.value,
      ttlDays: 30
    });
    const created = await services.teamService.createTeam(
      { ownerUserId: owner.id, seatLimit: 6 },
      initialCredential
    );
    const oldLine = await services.invitationService.createLineInvitationLink(
      owner.id,
      created.invitation?.id
    );
    const members = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        createUser(`safe-reduction-member-${index}@example.com`)
      )
    );
    await database.teamMembership.createMany({
      data: members.map((member) => ({
        teamId: created.team.teamId,
        userId: member.id,
        role: "MEMBER" as const,
        status: "ACTIVE" as const
      }))
    });
    const replacement = await prepareInvitationCredential({
      now: clock.value,
      ttlDays: 30
    });

    const result = await services.teamService.requestSeatLimitChange(
      owner.id,
      5,
      replacement
    );

    expect(result).toMatchObject({
      status: "APPLIED",
      activeMemberCount: 4,
      availableSeats: 1,
      invitation: { maxUses: 1, usedCount: 0 }
    });
    await expect(
      database.subscription.findUnique({
        where: { teamId: created.team.teamId },
        select: { seatLimit: true, pendingSeatLimit: true }
      })
    ).resolves.toEqual({ seatLimit: 5, pendingSeatLimit: null });
    await expect(
      database.invitation.findUnique({
        where: { id: created.invitation?.id ?? "" },
        select: { status: true }
      })
    ).resolves.toEqual({ status: "REPLACED" });
    await expect(
      database.invitationLink.findUnique({
        where: { id: oldLine.linkId },
        select: { status: true }
      })
    ).resolves.toEqual({ status: "REPLACED" });
  });

  it("enforces one-use and 24-hour LINE links and persists expiration", async () => {
    const clock = { value: new Date("2026-08-24T02:00:00.000Z") };
    const owner = await createUser("line-owner@example.com");
    const services = createServices(clock, "482734");
    const credential = await prepareInvitationCredential({
      now: clock.value,
      ttlDays: 30
    });
    const created = await services.teamService.createTeam(
      { ownerUserId: owner.id, seatLimit: 2 },
      credential
    );
    const line = await services.invitationService.createLineInvitationLink(
      owner.id,
      created.invitation?.id
    );
    const token = new URL(line.invitationLink).searchParams.get("token") ?? "";
    const grants = await Promise.all([
      services.invitationService.verifyLineInvitation(token),
      services.invitationService.verifyLineInvitation(token)
    ]);
    const candidates = await Promise.all([
      createUser("line-member-1@example.com"),
      createUser("line-member-2@example.com")
    ]);
    const attempts = await Promise.allSettled(
      candidates.map((candidate, index) =>
        services.invitationService.completeJoin({
          userId: candidate.id,
          joinToken: grants[index]?.joinToken ?? "",
          idempotencyKey: randomUUID()
        })
      )
    );
    expect(
      attempts.filter(({ status }) => status === "fulfilled")
    ).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(
      1
    );
    await expect(
      database.invitationLink.findUnique({
        where: { id: line.linkId },
        select: { status: true, usedCount: true }
      })
    ).resolves.toEqual({ status: "EXHAUSTED", usedCount: 1 });

    const expiringLine =
      await services.invitationService.createLineInvitationLink(
        owner.id,
        created.invitation?.id
      );
    const expiringToken =
      new URL(expiringLine.invitationLink).searchParams.get("token") ?? "";
    clock.value = new Date("2026-08-25T02:00:00.001Z");
    await expect(
      services.invitationService.verifyLineInvitation(expiringToken)
    ).rejects.toMatchObject({ code: "INVITATION_INVALID_OR_EXPIRED" });
    await expect(
      database.invitationLink.findUnique({
        where: { id: expiringLine.linkId },
        select: { status: true }
      })
    ).resolves.toEqual({ status: "EXPIRED" });

    clock.value = new Date("2026-09-23T02:00:00.001Z");
    await expect(
      services.invitationService.verifyPasswordInvitation({
        teamCode: created.team.teamCode,
        password: credential.password,
        attemptKey: "203.0.113.50"
      })
    ).rejects.toMatchObject({ code: "INVITATION_INVALID_OR_EXPIRED" });
    await expect(
      database.invitation.findUnique({
        where: { id: created.invitation?.id ?? "" },
        select: { status: true }
      })
    ).resolves.toEqual({ status: "EXPIRED" });
  });

  it("shares throttle counters across service instances and returns stable 429", async () => {
    const clock = { value: new Date("2026-08-24T03:00:00.000Z") };
    const services = Array.from(
      { length: 4 },
      () =>
        new SecurityThrottleService(
          new PrismaSecurityThrottleRepository(database),
          testPepper,
          () => clock.value
        )
    );
    const rule = {
      scope: "integration_magic_email",
      dimensions: ["member@example.com", "198.51.100.10"],
      maximumAttempts: 5,
      windowMinutes: 15,
      lockMinutes: 15
    } as const;
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) => {
        const service = services[index % services.length];
        if (!service) throw new Error("throttle_service_missing");
        return service.consume([rule]);
      })
    );
    expect(
      attempts.filter(({ status }) => status === "fulfilled")
    ).toHaveLength(5);
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected"
    );
    expect(rejected).toHaveLength(15);
    for (const rejection of rejected) {
      expect(rejection.reason).toMatchObject({
        code: "SECURITY_RATE_LIMITED",
        statusCode: 429
      });
    }
    await expect(database.securityThrottle.count()).resolves.toBe(1);
  });

  it("allows one user in multiple teams but rejects a duplicate in one team", async () => {
    const clock = { value: new Date("2026-08-24T04:00:00.000Z") };
    const sharedUser = await createUser("multi-team-user@example.com");
    const secondOwner = await createUser("multi-team-owner@example.com");
    const firstServices = createServices(clock, "482735");
    const first = await firstServices.teamService.createTeam({
      ownerUserId: sharedUser.id,
      seatLimit: 0
    });
    const secondServices = createServices(clock, "482736");
    const credential = await prepareInvitationCredential({
      now: clock.value,
      ttlDays: 30
    });
    const second = await secondServices.teamService.createTeam(
      { ownerUserId: secondOwner.id, seatLimit: 1 },
      credential
    );
    const grant =
      await secondServices.invitationService.verifyPasswordInvitation({
        teamCode: second.team.teamCode,
        password: credential.password,
        attemptKey: "198.51.100.60"
      });
    await secondServices.invitationService.completeJoin({
      userId: sharedUser.id,
      joinToken: grant.joinToken,
      idempotencyKey: randomUUID()
    });

    await expect(
      database.teamMembership.count({
        where: { userId: sharedUser.id, status: "ACTIVE" }
      })
    ).resolves.toBe(2);
    await expect(
      database.teamMembership.create({
        data: {
          teamId: second.team.teamId,
          userId: sharedUser.id,
          role: "MEMBER"
        }
      })
    ).rejects.toMatchObject({ code: "P2002" });
    expect(first.team.teamId).not.toBe(second.team.teamId);
  });

  it("admits one notification member to the final seat and revokes sessions on reset and disable", async () => {
    const clock = { value: new Date("2026-08-28T05:00:00.000Z") };
    const owner = await createUser("notification-owner@example.com");
    const services = createServices(clock, "482737");
    const invitation = await prepareInvitationCredential({
      now: clock.value,
      ttlDays: 30
    });
    const team = await services.teamService.createTeam(
      { ownerUserId: owner.id, seatLimit: 1 },
      invitation
    );
    const repository = new PrismaNotificationMemberRepository(database);
    const memberServices = ["CN-00000001", "CN-00000002"].map(
      (callNowId) =>
        new NotificationMemberService({
          repository,
          securityThrottle: new SecurityThrottleService(
            new PrismaSecurityThrottleRepository(database),
            testPepper,
            () => clock.value
          ),
          tokenPepper: testPepper,
          sessionIdleDays: 30,
          sessionAbsoluteDays: 90,
          maxActiveSessions: 5,
          now: () => clock.value,
          callNowIdGenerator: () => callNowId
        })
    );
    const attempts = await Promise.allSettled(
      memberServices.map((service, index) =>
        service.create({
          teamId: team.team.teamId,
          actorUserId: owner.id,
          displayName: `通知メンバー${index + 1}`
        })
      )
    );
    const created = attempts.find(
      (
        attempt
      ): attempt is PromiseFulfilledResult<
        Awaited<ReturnType<NotificationMemberService["create"]>>
      > => attempt.status === "fulfilled"
    );
    expect(created).toBeDefined();
    expect(
      attempts.filter(({ status }) => status === "fulfilled")
    ).toHaveLength(1);
    const rejected = attempts.find(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected"
    );
    if (!rejected) throw new Error("notification_member_conflict_missing");
    const conflict = rejected.reason as AppError;
    expect(conflict.code).toMatch(/MEMBER_CAPACITY/u);
    expect(conflict.statusCode).toBe(409);
    if (!created) throw new Error("notification_member_not_created");
    const service = memberServices[0];
    if (!service) throw new Error("notification_member_service_missing");
    const login = await service.login({
      callNowId: created.value.member.callNowId,
      password: created.value.initialPassword,
      ipAddress: "198.51.100.70",
      userAgent: "PostgreSQL acceptance"
    });
    await expect(
      service.authenticate(login.sessionToken)
    ).resolves.toMatchObject({
      member: { id: created.value.member.id }
    });
    const reset = await service.resetPassword({
      teamId: team.team.teamId,
      memberId: created.value.member.id,
      actorUserId: owner.id
    });
    await expect(
      service.authenticate(login.sessionToken)
    ).rejects.toMatchObject({
      code: "UNAUTHENTICATED"
    });
    const replacementLogin = await service.login({
      callNowId: created.value.member.callNowId,
      password: reset.initialPassword,
      ipAddress: "198.51.100.70"
    });
    const disabled = await service.disable({
      teamId: team.team.teamId,
      memberId: created.value.member.id,
      actorUserId: owner.id
    });
    expect(disabled.seats).toMatchObject({
      seatCount: 2,
      occupiedAdditionalSeats: 0,
      availableSeats: 1
    });
    await expect(
      service.authenticate(replacementLogin.sessionToken)
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const storedMember = await database.notificationMember.findUnique({
      where: { id: created.value.member.id },
      select: { passwordHash: true }
    });
    expect(storedMember?.passwordHash).toMatch(/^\$argon2id\$/u);
  });

  it("applies a pending seat decrease after a notification member is disabled", async () => {
    const clock = { value: new Date("2026-08-28T06:00:00.000Z") };
    const owner = await createUser("notification-reduction@example.com");
    const services = createServices(clock, "482738");
    const invitation = await prepareInvitationCredential({
      now: clock.value,
      ttlDays: 30
    });
    const team = await services.teamService.createTeam(
      { ownerUserId: owner.id, seatLimit: 2 },
      invitation
    );
    const repository = new PrismaNotificationMemberRepository(database);
    let generated = 0;
    const service = new NotificationMemberService({
      repository,
      securityThrottle: new SecurityThrottleService(
        new PrismaSecurityThrottleRepository(database),
        testPepper,
        () => clock.value
      ),
      tokenPepper: testPepper,
      sessionIdleDays: 30,
      sessionAbsoluteDays: 90,
      maxActiveSessions: 5,
      now: () => clock.value,
      callNowIdGenerator: () => `CN-${String(++generated).padStart(8, "0")}`
    });
    const first = await service.create({
      teamId: team.team.teamId,
      actorUserId: owner.id
    });
    await service.create({
      teamId: team.team.teamId,
      actorUserId: owner.id
    });
    const change = await services.teamService.requestSeatLimitChange(
      owner.id,
      1
    );
    expect(change.status).toBe("PENDING_CAPACITY");
    const result = await service.disable({
      teamId: team.team.teamId,
      memberId: first.member.id,
      actorUserId: owner.id
    });
    expect(result.seats).toMatchObject({
      seatCount: 2,
      additionalSeatLimit: 1,
      occupiedAdditionalSeats: 1,
      pendingSeatCount: null
    });
    await expect(
      database.subscription.findUniqueOrThrow({
        where: { teamId: team.team.teamId },
        select: { seatLimit: true, pendingSeatLimit: true }
      })
    ).resolves.toEqual({ seatLimit: 1, pendingSeatLimit: null });
  });

  it("creates one idempotent alert and fans out only to active recipients", async () => {
    const clock = { value: new Date("2026-08-28T07:00:00.000Z") };
    const owner = await createUser("alert-owner@example.com");
    const services = createServices(clock, "482740");
    const invitation = await prepareInvitationCredential({
      now: clock.value,
      ttlDays: 30
    });
    const team = await services.teamService.createTeam(
      { ownerUserId: owner.id, seatLimit: 2 },
      invitation
    );
    const memberRepository = new PrismaNotificationMemberRepository(database);
    let generated = 0;
    const memberService = new NotificationMemberService({
      repository: memberRepository,
      securityThrottle: new SecurityThrottleService(
        new PrismaSecurityThrottleRepository(database),
        testPepper,
        () => clock.value
      ),
      tokenPepper: testPepper,
      sessionIdleDays: 30,
      sessionAbsoluteDays: 90,
      maxActiveSessions: 5,
      now: () => clock.value,
      callNowIdGenerator: () => `CN-A${String(++generated).padStart(7, "0")}`
    });
    const activeMember = await memberService.create({
      teamId: team.team.teamId,
      actorUserId: owner.id,
      displayName: "通知担当"
    });
    const disabledMember = await memberService.create({
      teamId: team.team.teamId,
      actorUserId: owner.id,
      displayName: "停止済み"
    });
    await memberService.disable({
      teamId: team.team.teamId,
      memberId: disabledMember.member.id,
      actorUserId: owner.id
    });
    const connection = await createActiveMailConnection(
      owner.id,
      team.team.teamId,
      "alert-google-subject"
    );
    const alertService = new AlertService({
      repository: new PrismaAlertRepository(database),
      now: () => clock.value
    });
    const input = {
      teamId: team.team.teamId,
      sourceMailConnectionId: connection.id,
      sourceEventId: "gmail-history-1001",
      matchedKeyword: "停電のお知らせ",
      detectedAt: clock.value
    };

    const ingestionResults = await Promise.all([
      alertService.ingest(input),
      alertService.ingest(input)
    ]);
    const first = ingestionResults.find(({ created }) => created);
    const duplicate = ingestionResults.find(({ created }) => !created);
    if (!first || !duplicate) {
      throw new Error("Expected one created and one idempotent alert result");
    }

    expect(first).toMatchObject({
      created: true,
      alert: { recipientCount: 2, matchedKeyword: "停電のお知らせ" }
    });
    expect(duplicate).toMatchObject({
      created: false,
      alert: { id: first.alert.id, recipientCount: 2 }
    });
    await expect(database.alert.count()).resolves.toBe(1);
    await expect(
      database.alertRecipient.findMany({
        where: { alertId: first.alert.id },
        select: { kind: true, notificationMemberId: true }
      })
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "OWNER", notificationMemberId: null },
        {
          kind: "NOTIFICATION_MEMBER",
          notificationMemberId: activeMember.member.id
        }
      ])
    );
    await expect(
      database.alertRecipient.count({
        where: { notificationMemberId: disabledMember.member.id }
      })
    ).resolves.toBe(0);
  });

  it("allows one simultaneous acknowledgement and enforces team isolation", async () => {
    const clock = { value: new Date("2026-08-28T08:00:00.000Z") };
    const owner = await createUser("ack-owner@example.com");
    const services = createServices(clock, "482741");
    const invitation = await prepareInvitationCredential({
      now: clock.value,
      ttlDays: 30
    });
    const team = await services.teamService.createTeam(
      { ownerUserId: owner.id, seatLimit: 1 },
      invitation
    );
    const memberService = new NotificationMemberService({
      repository: new PrismaNotificationMemberRepository(database),
      securityThrottle: new SecurityThrottleService(
        new PrismaSecurityThrottleRepository(database),
        testPepper,
        () => clock.value
      ),
      tokenPepper: testPepper,
      sessionIdleDays: 30,
      sessionAbsoluteDays: 90,
      maxActiveSessions: 5,
      now: () => clock.value,
      callNowIdGenerator: () => "CN-B0000001"
    });
    const member = await memberService.create({
      teamId: team.team.teamId,
      actorUserId: owner.id
    });
    const connection = await createActiveMailConnection(
      owner.id,
      team.team.teamId,
      "ack-google-subject"
    );
    const alertService = new AlertService({
      repository: new PrismaAlertRepository(database),
      now: () => clock.value
    });
    const created = await alertService.ingest({
      teamId: team.team.teamId,
      sourceMailConnectionId: connection.id,
      sourceEventId: "gmail-history-2001",
      matchedKeyword: "システム障害",
      detectedAt: clock.value
    });

    const acknowledgements = await Promise.all([
      alertService.acknowledgeByOwner({
        teamId: team.team.teamId,
        alertId: created.alert.id,
        userId: owner.id
      }),
      alertService.acknowledgeByNotificationMember({
        teamId: team.team.teamId,
        alertId: created.alert.id,
        memberId: member.member.id
      })
    ]);
    expect(
      acknowledgements.filter(({ alreadyAcknowledged }) => !alreadyAcknowledged)
    ).toHaveLength(1);
    expect(
      acknowledgements.filter(({ alreadyAcknowledged }) => alreadyAcknowledged)
    ).toHaveLength(1);
    expect(acknowledgements[0]?.alert.status).toBe("ACKNOWLEDGED");
    expect(acknowledgements[1]?.alert.status).toBe("ACKNOWLEDGED");
    await expect(
      database.auditEvent.count({
        where: { action: "ALERT_ACKNOWLEDGED", targetId: created.alert.id }
      })
    ).resolves.toBe(1);

    const otherOwner = await createUser("other-alert-owner@example.com");
    const otherTeam = await createServices(
      clock,
      "482742"
    ).teamService.createTeam({
      ownerUserId: otherOwner.id,
      seatLimit: 0
    });
    await expect(
      alertService.acknowledgeByOwner({
        teamId: otherTeam.team.teamId,
        alertId: created.alert.id,
        userId: otherOwner.id
      })
    ).rejects.toMatchObject({ code: "ALERT_NOT_FOUND", statusCode: 404 });
    await expect(
      alertService.listForOwner(otherTeam.team.teamId, otherOwner.id)
    ).resolves.toEqual([]);
  });
});

class PostgresGoogleOAuthProvider implements GoogleOAuthProvider {
  private nonce: string | null = null;

  public createAuthorizationUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly nonce: string;
  }): string {
    const url = new URL("https://accounts.example/authorize");
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("nonce", input.nonce);
    this.nonce = input.nonce;
    return url.toString();
  }

  public async exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly expectedNonce: string;
  }): Promise<GoogleIdentityProfile> {
    if (
      input.code !== "postgres-google-code" ||
      !input.codeVerifier ||
      input.expectedNonce !== this.nonce
    ) {
      throw new Error("Invalid PostgreSQL Google auth fixture");
    }
    return {
      provider: "GOOGLE",
      subject: "postgres-google-subject",
      email: "postgres-google@example.com",
      emailVerified: true,
      displayName: "PostgreSQL Google User"
    };
  }
}

class PostgresPrimaryOAuthProvider implements PrimaryAuthProviderAdapter {
  private nonce: string | null = null;

  public constructor(
    public readonly provider: "GOOGLE" | "MICROSOFT" | "APPLE",
    private readonly subject: string,
    private readonly email: string
  ) {}

  public createAuthorizationUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly nonce: string;
  }): string {
    this.nonce = input.nonce;
    return `https://identity.example/authorize?state=${encodeURIComponent(input.state)}`;
  }

  public async exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly expectedNonce: string;
  }): Promise<PrimaryIdentityProfile> {
    if (
      input.code !== "postgres-primary-code" ||
      !input.codeVerifier ||
      input.expectedNonce !== this.nonce
    ) {
      throw new Error("Invalid PostgreSQL primary auth fixture");
    }
    return {
      provider: this.provider,
      subject: this.subject,
      email: this.email,
      emailVerified: true,
      displayName: "PostgreSQL Primary User"
    };
  }
}

async function completePrimaryLogin(
  service: PrimaryAuthService,
  provider: "GOOGLE" | "MICROSOFT" | "APPLE"
) {
  const request = await service.createAuthorizationRequest({
    provider,
    intent: "LOGIN",
    authenticatedUserId: null
  });
  const result = await service.completeAuthorization({
    provider,
    state: request.state,
    code: "postgres-primary-code",
    authenticatedUserId: null,
    clientContext: { ipAddress: "127.0.0.1", userAgent: "Postgres test" }
  });
  if (result.intent !== "LOGIN") throw new Error("expected_primary_login");
  return result;
}

class PostgresMailProviderAdapter implements MailProviderAdapter {
  public readonly provider;
  public static readonly refreshToken =
    "synthetic-postgres-refresh-token-for-tests-only";
  public readonly refreshToken;
  public readonly revokedTokens: string[] = [];
  private nonce: string | null = null;

  public constructor(provider: "GOOGLE" | "MICROSOFT" = "GOOGLE") {
    this.provider = provider;
    this.refreshToken =
      provider === "GOOGLE"
        ? PostgresMailProviderAdapter.refreshToken
        : "synthetic-postgres-microsoft-refresh-token-for-tests-only";
  }

  public createAuthorizationUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly nonce: string;
  }): string {
    const url = new URL("https://accounts.example/gmail-authorize");
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("nonce", input.nonce);
    this.nonce = input.nonce;
    return url.toString();
  }

  public async exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly expectedNonce: string;
  }): Promise<MailOAuthGrant> {
    if (
      input.code !==
        (this.provider === "GOOGLE"
          ? "postgres-gmail-code"
          : "postgres-microsoft-code") ||
      !input.codeVerifier ||
      input.expectedNonce !== this.nonce
    ) {
      throw new Error("Invalid PostgreSQL Gmail auth fixture");
    }
    return {
      provider: this.provider,
      subject:
        this.provider === "GOOGLE"
          ? "postgres-gmail-subject"
          : "tenant:postgres-microsoft-subject",
      email:
        this.provider === "GOOGLE"
          ? "monitoring-postgres@example.com"
          : "monitoring-postgres@outlook.example",
      emailVerified: true,
      refreshToken: this.refreshToken,
      grantedScopes: [
        this.provider === "GOOGLE"
          ? GMAIL_READONLY_SCOPE
          : "https://graph.microsoft.com/Mail.Read"
      ]
    };
  }

  public async refreshAccessToken() {
    return {
      accessToken: "synthetic-postgres-access-token-for-tests-only",
      expiresAt: null,
      rotatedRefreshToken: null
    };
  }

  public async revokeAuthorization(refreshToken: string): Promise<void> {
    this.revokedTokens.push(refreshToken);
  }

  public classifyProviderError(error: unknown) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    return code === "invalid_grant"
      ? ("REAUTHORIZATION_REQUIRED" as const)
      : ("UNKNOWN" as const);
  }
}

function createServices(
  clock: { value: Date },
  teamCode: string
): {
  readonly teamRepository: PrismaTeamRepository;
  readonly teamService: TeamService;
  readonly invitationService: InvitationService;
} {
  const teamRepository = new PrismaTeamRepository(database);
  const teamService = new TeamService({
    repository: teamRepository,
    now: () => clock.value,
    teamCodeGenerator: () => teamCode
  });
  return {
    teamRepository,
    teamService,
    invitationService: new InvitationService({
      repository: new PrismaInvitationRepository(database),
      teamService,
      publicOrigin: "https://acceptance.call-now.example",
      tokenPepper: testPepper,
      invitationTtlDays: 30,
      joinGrantTtlMinutes: 15,
      lineLinkTtlHours: 24,
      securityThrottle: new SecurityThrottleService(
        new PrismaSecurityThrottleRepository(database),
        testPepper,
        () => clock.value
      ),
      now: () => clock.value
    })
  };
}

function createUser(email: string) {
  return database.user.create({
    data: { email, emailVerifiedAt: new Date("2026-08-24T00:00:00.000Z") }
  });
}

async function createActiveMailConnection(
  userId: string,
  teamId: string,
  providerSubject: string
) {
  const authorization = await database.mailAuthorization.create({
    data: {
      userId,
      provider: "GOOGLE",
      providerSubject,
      email: `${providerSubject}@example.com`,
      grantedScopes: [GMAIL_READONLY_SCOPE],
      status: "ACTIVE",
      lastVerifiedAt: new Date("2026-08-28T00:00:00.000Z")
    }
  });
  return database.mailConnection.create({
    data: {
      teamId,
      mailAuthorizationId: authorization.id,
      status: "ACTIVE"
    }
  });
}

function assertDedicatedTestDatabase(value: string): void {
  let databaseName: string;
  try {
    databaseName = new URL(value).pathname.replace(/^\//, "");
  } catch {
    throw new Error("DATABASE_URL must identify a dedicated test database");
  }
  if (!/(?:test|acceptance)/i.test(databaseName)) {
    throw new Error(
      "PostgreSQL integration tests require a database name containing test or acceptance"
    );
  }
}
