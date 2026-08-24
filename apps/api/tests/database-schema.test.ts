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
      "AuthCredential",
      "Session",
      "Team",
      "TeamMembership",
      "Subscription",
      "Invitation",
      "InvitationRedemption",
      "AuditEvent",
      "SecurityThrottle"
    ]) {
      expect(schema).toContain(`model ${model} {`);
    }
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
