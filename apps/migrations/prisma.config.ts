import { config as loadDotenv } from "dotenv";
import { defineConfig, env } from "prisma/config";

loadDotenv({
  path: new URL("../../.env", import.meta.url),
  override: false,
  quiet: true
});

export default defineConfig({
  schema: "../api/prisma/schema.prisma",
  migrations: {
    path: "../api/prisma/migrations"
  },
  datasource: {
    url: env("DATABASE_URL")
  }
});
