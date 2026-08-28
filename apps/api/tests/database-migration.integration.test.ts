import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const baseMigration =
  readFileSync(
    new URL(
      "../prisma/migrations/20260824000100_phase1_foundation/migration.sql",
      import.meta.url
    ),
    "utf8"
  ) +
  readFileSync(
    new URL(
      "../prisma/migrations/20260824000200_security_throttles/migration.sql",
      import.meta.url
    ),
    "utf8"
  ) +
  readFileSync(
    new URL(
      "../prisma/migrations/20260824000300_remove_password_credential/migration.sql",
      import.meta.url
    ),
    "utf8"
  ) +
  readFileSync(
    new URL(
      "../prisma/migrations/20260824000400_paid_seat_increase_idempotency/migration.sql",
      import.meta.url
    ),
    "utf8"
  ) +
  readFileSync(
    new URL(
      "../prisma/migrations/20260825000100_google_user_session/migration.sql",
      import.meta.url
    ),
    "utf8"
  );
const gmailMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260826000100_gmail_monitoring_connection/migration.sql",
    import.meta.url
  ),
  "utf8"
);
const mailProviderMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260826000200_mail_provider_foundation/migration.sql",
    import.meta.url
  ),
  "utf8"
);
const primaryProviderMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260827000100_multi_provider_primary_auth/migration.sql",
    import.meta.url
  ),
  "utf8"
);
const multipleMailConnectionsMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260828000100_multiple_mail_connections/migration.sql",
    import.meta.url
  ),
  "utf8"
);
const notificationMemberMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260828000200_notification_members/migration.sql",
    import.meta.url
  ),
  "utf8"
);
const alertMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260828000300_alert_fanout/migration.sql",
    import.meta.url
  ),
  "utf8"
);
const migration =
  baseMigration +
  gmailMigration +
  mailProviderMigration +
  primaryProviderMigration +
  multipleMailConnectionsMigration +
  notificationMemberMigration +
  alertMigration;

const databases: PGlite[] = [];

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => database.close())
  );
});

describe("PostgreSQL migrations", () => {
  it("apply cleanly and enforce identity, team, and owner invariants", async () => {
    const database = new PGlite();
    databases.push(database);
    await database.exec(migration);

    await database.exec(`
      INSERT INTO users (id, email, "updatedAt") VALUES
        ('00000000-0000-0000-0000-000000000001', 'owner@example.com', now()),
        ('00000000-0000-0000-0000-000000000002', 'second@example.com', now());
      INSERT INTO teams (id, "publicCode", "updatedAt") VALUES
        ('10000000-0000-0000-0000-000000000001', '482731', now());
      INSERT INTO team_memberships (id, "teamId", "userId", role, status) VALUES
        ('20000000-0000-0000-0000-000000000001',
         '10000000-0000-0000-0000-000000000001',
         '00000000-0000-0000-0000-000000000001',
         'OWNER', 'ACTIVE');
    `);

    await expect(
      database.exec(`
        INSERT INTO team_memberships (id, "teamId", "userId", role, status)
        VALUES (
          '20000000-0000-0000-0000-000000000002',
          '10000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-000000000002',
          'OWNER', 'ACTIVE'
        );
      `)
    ).rejects.toThrow();

    await expect(
      database.exec(`
        INSERT INTO teams (id, "publicCode", "updatedAt")
        VALUES ('10000000-0000-0000-0000-000000000002', 'ABC123', now());
      `)
    ).rejects.toThrow();

    const credentialColumns = await database.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'auth_credentials';
    `);
    expect(
      credentialColumns.rows.map(({ column_name }) => column_name)
    ).not.toContain("passwordHash");

    const credentialTypes = await database.query<{ enumlabel: string }>(`
      SELECT enumlabel
      FROM pg_enum
      JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
      WHERE pg_type.typname = 'CredentialType'
      ORDER BY enumsortorder;
    `);
    expect(credentialTypes.rows).toEqual([{ enumlabel: "PASSKEY" }]);

    const identityProviders = await database.query<{ enumlabel: string }>(`
      SELECT enumlabel
      FROM pg_enum
      JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
      WHERE pg_type.typname = 'IdentityProvider'
      ORDER BY enumsortorder;
    `);
    expect(identityProviders.rows).toEqual([
      { enumlabel: "GOOGLE" },
      { enumlabel: "MICROSOFT" },
      { enumlabel: "APPLE" }
    ]);

    const challengeKinds = await database.query<{ enumlabel: string }>(`
      SELECT enumlabel
      FROM pg_enum
      JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
      WHERE pg_type.typname = 'ChallengeKind'
      ORDER BY enumsortorder;
    `);
    expect(challengeKinds.rows).toContainEqual({ enumlabel: "GMAIL_OAUTH" });
    expect(challengeKinds.rows).toContainEqual({
      enumlabel: "MICROSOFT_MAIL_OAUTH"
    });

    const mailTables = await database.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('mail_authorizations', 'mail_connections')
      ORDER BY table_name;
    `);
    expect(mailTables.rows).toEqual([
      { table_name: "mail_authorizations" },
      { table_name: "mail_connections" }
    ]);

    const mailProviders = await database.query<{ enumlabel: string }>(`
      SELECT enumlabel
      FROM pg_enum
      JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
      WHERE pg_type.typname = 'MailProvider'
      ORDER BY enumsortorder;
    `);
    expect(mailProviders.rows).toEqual([
      { enumlabel: "GOOGLE" },
      { enumlabel: "MICROSOFT" }
    ]);

    const memberTables = await database.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'notification_members',
          'notification_member_sessions'
        )
      ORDER BY table_name;
    `);
    expect(memberTables.rows).toEqual([
      { table_name: "notification_member_sessions" },
      { table_name: "notification_members" }
    ]);

    const alertTables = await database.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('alerts', 'alert_recipients')
      ORDER BY table_name;
    `);
    expect(alertTables.rows).toEqual([
      { table_name: "alert_recipients" },
      { table_name: "alerts" }
    ]);

    await database.exec(`
      INSERT INTO external_identities (
        id, "userId", provider, "providerSubject", email, "updatedAt"
      ) VALUES (
        '30000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000001',
        'GOOGLE', 'google-subject-1', 'owner@example.com', now()
      );
    `);
    await expect(
      database.exec(`
        INSERT INTO external_identities (
          id, "userId", provider, "providerSubject", email, "updatedAt"
        ) VALUES (
          '30000000-0000-0000-0000-000000000002',
          '00000000-0000-0000-0000-000000000002',
          'GOOGLE', 'google-subject-1', 'second@example.com', now()
        );
      `)
    ).rejects.toThrow();

    await database.exec(`
      INSERT INTO mail_authorizations (
        id, "userId", provider, "providerSubject", email,
        "grantedScopes", status, "updatedAt"
      ) VALUES (
        '40000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000001',
        'GOOGLE', 'gmail-monitoring-subject-1', 'monitoring@example.com',
        ARRAY['https://www.googleapis.com/auth/gmail.readonly'],
        'ACTIVE', now()
      );
      INSERT INTO mail_connections (
        id, "teamId", "mailAuthorizationId", status, "updatedAt"
      ) VALUES (
        '50000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000001',
        '40000000-0000-0000-0000-000000000001',
        'ACTIVE', now()
      );
    `);
    const separatedIdentities = await database.query<{
      login_subject: string;
      monitoring_subject: string;
    }>(`
      SELECT
        login_identity."providerSubject" AS login_subject,
        mail_authorization."providerSubject" AS monitoring_subject
      FROM external_identities AS login_identity
      JOIN mail_authorizations AS mail_authorization
        ON mail_authorization."userId" = login_identity."userId";
    `);
    expect(separatedIdentities.rows).toEqual([
      {
        login_subject: "google-subject-1",
        monitoring_subject: "gmail-monitoring-subject-1"
      }
    ]);
  });

  it("preserves provisional Gmail data but requires fresh authorization", async () => {
    const database = new PGlite();
    databases.push(database);
    await database.exec(baseMigration);
    await database.exec(`
      INSERT INTO users (id, email, "updatedAt") VALUES
        ('00000000-0000-0000-0000-000000000011', 'legacy-owner@example.com', now());
      INSERT INTO teams (id, "publicCode", "updatedAt") VALUES
        ('10000000-0000-0000-0000-000000000011', '482739', now());
      INSERT INTO team_memberships (
        id, "teamId", "userId", role, status
      ) VALUES (
        '20000000-0000-0000-0000-000000000011',
        '10000000-0000-0000-0000-000000000011',
        '00000000-0000-0000-0000-000000000011',
        'OWNER', 'ACTIVE'
      );
      INSERT INTO gmail_connections (
        id, "teamId", "googleSubject", email,
        "encryptedRefreshToken", scopes, status, "updatedAt"
      ) VALUES (
        '50000000-0000-0000-0000-000000000011',
        '10000000-0000-0000-0000-000000000011',
        'legacy-google-subject', 'legacy-monitoring@example.com',
        'legacy-encrypted-payload',
        ARRAY['https://www.googleapis.com/auth/gmail.readonly'],
        'ACTIVE', now()
      );
    `);

    await database.exec(gmailMigration);

    const migrated = await database.query<{
      authorization_status: string;
      connection_status: string;
      email: string;
      encryption_provider: string;
    }>(`
      SELECT
        gmail_authorization.status AS authorization_status,
        gmail_connection.status AS connection_status,
        gmail_authorization.email,
        gmail_authorization."encryptionProvider" AS encryption_provider
      FROM gmail_connections AS gmail_connection
      JOIN gmail_authorizations AS gmail_authorization
        ON gmail_authorization.id = gmail_connection."gmailAuthorizationId";
    `);
    expect(migrated.rows).toEqual([
      {
        authorization_status: "REAUTH_REQUIRED",
        connection_status: "REAUTH_REQUIRED",
        email: "legacy-monitoring@example.com",
        encryption_provider: "LEGACY_UNKNOWN"
      }
    ]);

    await database.exec(mailProviderMigration);
    const generalized = await database.query<{
      provider: string;
      authorization_status: string;
      connection_status: string;
    }>(`
      SELECT
        mail_authorization.provider,
        mail_authorization.status AS authorization_status,
        mail_connection.status AS connection_status
      FROM mail_connections AS mail_connection
      JOIN mail_authorizations AS mail_authorization
        ON mail_authorization.id = mail_connection."mailAuthorizationId";
    `);
    expect(generalized.rows).toEqual([
      {
        provider: "GOOGLE",
        authorization_status: "REAUTH_REQUIRED",
        connection_status: "REAUTH_REQUIRED"
      }
    ]);
  });
});
