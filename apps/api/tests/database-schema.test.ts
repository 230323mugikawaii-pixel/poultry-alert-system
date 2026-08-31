import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync(
  new URL("../prisma/schema.prisma", import.meta.url),
  "utf8"
);
const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260824000100_phase1_foundation/migration.sql",
    import.meta.url
  ),
  "utf8"
);

describe("database foundation", () => {
  it("defines the required Phase 1 models", () => {
    for (const model of [
      "User",
      "ExternalIdentity",
      "AuthCredential",
      "Session",
      "Team",
      "TeamMembership",
      "Subscription",
      "Invitation",
      "InvitationRedemption",
      "AuditEvent",
      "SecurityThrottle",
      "MailAuthorization",
      "MailConnection",
      "Alert",
      "AlertRecipient",
      "NotificationTest",
      "UserNotification",
      "FeedbackSubmission"
    ]) {
      expect(schema).toContain(`model ${model} {`);
    }
  });

  it("keeps service notifications separate from monitored-mail alerts", () => {
    expect(schema).toContain("enum UserNotificationType");
    expect(schema).toContain("FEEDBACK_REPLY");
    expect(schema).toContain("model FeedbackSubmission {");
    expect(schema).toContain("model UserNotification {");
    expect(schema).toMatch(
      /model UserNotification \{[^}]*deletedAt\s+DateTime\?/s
    );
    expect(schema).toContain("@@index([userId, readAt, createdAt])");
    expect(schema).toContain("@@index([userId, deletedAt, readAt, createdAt])");
    expect(schema).toContain('@@map("user_notifications")');
  });

  it("defines provider-neutral alert fan-out and idempotency", () => {
    expect(schema).toContain("enum AlertStatus");
    expect(schema).toContain("enum AlertKind");
    expect(schema).toMatch(/enum AlertKind \{[^}]*REAL[^}]*TEST/s);
    expect(schema).toContain("enum AlertDeliveryChannel");
    expect(schema).toContain("sourceEventId");
    expect(schema).toContain(
      "@@unique([sourceMailConnectionId, sourceEventId])"
    );
    expect(schema).toContain("model AlertRecipient {");
    expect(schema).toContain("notificationMemberId");
    expect(schema).toMatch(/model AlertRecipient \{[^}]*readAt\s+DateTime\?/s);
    expect(schema).toMatch(
      /model AlertRecipient \{[^}]*dismissedAt\s+DateTime\?/s
    );
    expect(schema).toContain(
      "@@index([notificationMemberId, readAt, createdAt])"
    );
    expect(schema).toContain(
      "@@index([userId, dismissedAt, readAt, createdAt])"
    );
    expect(schema).toContain(
      "@@index([notificationMemberId, dismissedAt, readAt, createdAt])"
    );
    expect(schema).toContain("model NotificationTest {");
    expect(schema).toContain("enum NotificationTestStatus");
  });

  it("separates Call Now login identity from mail monitoring authorization", () => {
    const mailAuthorization = schema.match(
      /model MailAuthorization \{([^}]*)\}/
    )?.[1];
    const mailConnection = schema.match(
      /model MailConnection \{([^}]*)\}/
    )?.[1];

    expect(mailAuthorization).toContain("userId");
    expect(mailAuthorization).toContain("encryptedRefreshToken");
    expect(mailAuthorization).not.toMatch(/userId\s+String\s+@unique/);
    expect(mailAuthorization).toContain("@@index([userId, status, revokedAt])");
    expect(mailConnection).toContain("teamId");
    expect(mailConnection).toContain("mailAuthorizationId");
    expect(mailConnection).toContain("@@unique([teamId, mailAuthorizationId])");
    expect(mailConnection).not.toContain("encryptedRefreshToken");
    expect(schema).toContain("GMAIL_OAUTH");
    expect(schema).toContain("MICROSOFT_MAIL_OAUTH");
    expect(schema).toMatch(/enum MailProvider \{[^}]*GOOGLE[^}]*MICROSOFT/s);
  });

  it("binds Google identities by provider subject instead of email alone", () => {
    expect(schema).toContain("enum IdentityProvider");
    expect(schema).toContain("providerSubject String");
    expect(schema).toContain("@@unique([provider, providerSubject])");
    expect(schema).toContain("@@unique([userId, provider])");
  });

  it("enforces additional member seat and invitation invariants", () => {
    expect(migration).toContain('"seatLimit" >= 0');
    expect(migration).toContain('"usedCount" <= "maxUses"');
    expect(migration).toContain("team_memberships_one_active_owner_per_team");
    expect(migration).toContain("invitations_one_active_password_per_team");
    expect(migration).toContain("CHECK (\"publicCode\" ~ '^[0-9]{6}$')");
  });

  it("does not define Call Now password credentials in the initial release", () => {
    const credentialType = schema.match(/enum CredentialType \{([^}]*)\}/)?.[1];
    const credentialModel = schema.match(
      /model AuthCredential \{([^}]*)\}/
    )?.[1];

    expect(credentialType).toContain("PASSKEY");
    expect(credentialType).not.toContain("PASSWORD");
    expect(credentialModel).not.toContain("passwordHash");
  });
});
