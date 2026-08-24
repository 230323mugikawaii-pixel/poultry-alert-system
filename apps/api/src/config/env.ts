import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const EnvironmentSchema = Type.Object({
  APP_ENV: Type.Union(
    [
      Type.Literal("development"),
      Type.Literal("test"),
      Type.Literal("staging"),
      Type.Literal("production")
    ],
    { default: "development" }
  ),
  HOST: Type.String({ default: "0.0.0.0" }),
  PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 8080 }),
  LOG_LEVEL: Type.Union(
    [
      Type.Literal("fatal"),
      Type.Literal("error"),
      Type.Literal("warn"),
      Type.Literal("info"),
      Type.Literal("debug"),
      Type.Literal("trace"),
      Type.Literal("silent")
    ],
    { default: "info" }
  ),
  PUBLIC_ORIGIN: Type.String({ minLength: 1 }),
  COOKIE_NAME: Type.String({ minLength: 1, default: "callnow_session" }),
  DATABASE_URL: Type.String({ minLength: 1 })
});

export type AppEnvironment = Static<typeof EnvironmentSchema>;

export function loadEnvironment(
  source: NodeJS.ProcessEnv = process.env
): AppEnvironment {
  const candidate = {
    APP_ENV: source.APP_ENV ?? "development",
    HOST: source.HOST ?? "0.0.0.0",
    PORT: Number(source.PORT ?? "8080"),
    LOG_LEVEL: source.LOG_LEVEL ?? "info",
    PUBLIC_ORIGIN: source.PUBLIC_ORIGIN ?? "http://127.0.0.1:8080",
    COOKIE_NAME: source.COOKIE_NAME ?? "callnow_session",
    DATABASE_URL:
      source.DATABASE_URL ??
      "postgresql://callnow:callnow@127.0.0.1:5432/callnow"
  };

  if (!Value.Check(EnvironmentSchema, candidate)) {
    const details = [...Value.Errors(EnvironmentSchema, candidate)]
      .map((error) => `${error.path || "/"}: ${error.message}`)
      .join(", ");

    throw new Error(`Invalid environment configuration: ${details}`);
  }

  try {
    const publicOrigin = new URL(candidate.PUBLIC_ORIGIN);
    if (publicOrigin.origin !== candidate.PUBLIC_ORIGIN) {
      throw new Error("path_not_allowed");
    }
  } catch {
    throw new Error("PUBLIC_ORIGIN must be a valid origin without a path");
  }

  if (
    candidate.APP_ENV === "production" &&
    !candidate.PUBLIC_ORIGIN.startsWith("https://")
  ) {
    throw new Error("PUBLIC_ORIGIN must use HTTPS in production");
  }

  return candidate;
}
