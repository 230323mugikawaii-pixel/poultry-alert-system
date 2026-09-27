import { spawnSync } from "node:child_process";
import { stagingDatabase } from "./guard.mjs";
try {
  stagingDatabase(process.env, process.env.DATABASE_URL, ["callnow_migrator"]);
  const mode = process.argv[2];
  const commands = mode === "apply"
    ? [["migrate", "deploy", "--config", "prisma.config.ts"]]
    : mode === "verify"
      ? [["migrate", "status", "--config", "prisma.config.ts"],
        ["migrate", "diff", "--from-config-datasource", "--to-schema", "../api/prisma/schema.prisma", "--exit-code"]]
      : [];
  if (!commands.length) throw new Error();
  for (const args of commands) {
    const result = spawnSync("./node_modules/.bin/prisma", args, {
      cwd: new URL("../../../apps/migrations/", import.meta.url),
      env: process.env, encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
      timeout: 240_000, stdio: ["ignore", "pipe", "pipe"]
    });
    // Prisma may include datasource URLs in diagnostics. Do not echo its streams.
    console.log(JSON.stringify({ check: args[1], success: result.status === 0, exitCode: result.status }));
    if (result.status !== 0) throw new Error();
  }
} catch {
  console.error("STAGING_MIGRATION_CHECK_FAILED; raw datasource output suppressed");
  process.exitCode = 1;
}
