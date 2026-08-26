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
      "GmailAuthorization",
      "GmailConnection"
    ]) {
      expect(schema).toContain(`model ${model} {`);
    }
  });

  it("separates Call Now login identity from Gmail monitoring authorization", () => {
    const gmailAuthorization = schema.match(
      /model GmailAuthorization \{([^}]*)\}/
    )?.[1];
    const gmailConnection = schema.match(
      /model GmailConnection \{([^}]*)\}/
    )?.[1];

    expect(gmailAuthorization).toContain("userId");
    expect(gmailAuthorization).toContain("encryptedRefreshToken");
    expect(gmailAuthorization).toMatch(/userId\s+String\s+@unique/);
    expect(gmailConnection).toContain("teamId");
    expect(gmailConnection).toContain("gmailAuthorizationId");
    expect(gmailConnection).not.toContain("encryptedRefreshToken");
    expect(schema).toContain("GMAIL_OAUTH");
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
