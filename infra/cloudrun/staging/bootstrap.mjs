// Explicit one-off staging administration. Never imported by the API or workers.
import { createRequire } from "node:module";
import { stagingDatabase, database } from "./guard.mjs";
const require = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const { Pool } = require("pg");
let pool;
try {
  const env = process.env;
  const phase = process.argv[2];
  if (!["roles", "grants", "inspect"].includes(phase)) throw new Error();
  stagingDatabase(env, env.DATABASE_URL, phase === "inspect"
    ? ["callnow_runtime", "callnow_migrator"] : ["postgres"]);
  pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
  if (phase === "roles") {
    const urls = [
      stagingDatabase(env, env.MIGRATION_DATABASE_URL, ["callnow_migrator"]),
      stagingDatabase(env, env.RUNTIME_DATABASE_URL, ["callnow_runtime"]),
      stagingDatabase(env, env.WORKER_DATABASE_URL, ["callnow_worker"])
    ];
    const tables = await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'");
    if (tables.rows[0].n !== 0) throw new Error("STAGING_NOT_EMPTY");
    await pool.query("BEGIN");
    for (const url of urls) {
      // User names and password alphabet have been strictly allowlisted above.
      const existing = await pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [url.username]);
      if (existing.rowCount) throw new Error("STAGING_ROLE_EXISTS");
      await pool.query(`CREATE ROLE ${url.username} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${url.password}'`);
    }
    await pool.query(`ALTER DATABASE ${database} OWNER TO callnow_migrator`);
    await pool.query(`REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC`);
    await pool.query(`GRANT CONNECT ON DATABASE ${database} TO callnow_migrator,callnow_runtime,callnow_worker`);
    await pool.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await pool.query("GRANT USAGE,CREATE ON SCHEMA public TO callnow_migrator");
    await pool.query("GRANT USAGE ON SCHEMA public TO callnow_runtime,callnow_worker");
    await pool.query("ALTER DEFAULT PRIVILEGES FOR ROLE callnow_migrator IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO callnow_runtime");
    await pool.query("ALTER DEFAULT PRIVILEGES FOR ROLE callnow_migrator IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO callnow_runtime");
    await pool.query("COMMIT");
    console.log("STAGING_ROLES_CREATED");
  } else if (phase === "grants") {
    await pool.query("BEGIN");
    await pool.query("GRANT SELECT ON alerts,alert_recipients,teams,subscriptions,users,team_memberships,notification_members,device_push_registrations,reliability_outbox,notification_deliveries TO callnow_worker");
    await pool.query("GRANT INSERT,UPDATE ON reliability_outbox,notification_deliveries TO callnow_worker");
    await pool.query("GRANT UPDATE ON device_push_registrations TO callnow_worker");
    await pool.query("COMMIT");
    console.log("STAGING_WORKER_GRANTS_APPLIED");
  } else {
    const result = await pool.query(`SELECT
      (SELECT count(*)::int FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS migrations,
      (SELECT count(*)::int FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS failed_migrations,
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM mail_authorizations) AS mail_authorizations,
      (SELECT count(*)::int FROM alerts) AS alerts,
      (SELECT count(*)::int FROM reliability_outbox) AS outbox,
      (SELECT count(*)::int FROM notification_deliveries) AS deliveries`);
    console.log(JSON.stringify({ stagingOnly: true, ...result.rows[0] }));
  }
} catch {
  console.error("STAGING_DATABASE_ADMIN_FAILED; no credentials or raw SQL errors emitted");
  process.exitCode = 1;
} finally {
  await pool?.end();
}
