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
  TRUST_PROXY_HOPS: Type.Integer({ minimum: 0, maximum: 5, default: 0 }),
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
  DATABASE_URL: Type.String({ minLength: 1 }),
  AUTH_TOKEN_PEPPER: Type.String({ minLength: 32 }),
  GOOGLE_OAUTH_CLIENT_ID: Type.String({ minLength: 1 }),
  GOOGLE_OAUTH_CLIENT_SECRET: Type.String({ minLength: 1 }),
  GOOGLE_OAUTH_REDIRECT_URI: Type.String({ minLength: 1 }),
  GOOGLE_OAUTH_STATE_TTL_MINUTES: Type.Integer({
    minimum: 5,
    maximum: 30
  }),
  MAGIC_LINK_TTL_MINUTES: Type.Integer({ minimum: 5, maximum: 60 }),
  SESSION_IDLE_DAYS: Type.Integer({ minimum: 1, maximum: 90 }),
  SESSION_ABSOLUTE_DAYS: Type.Integer({ minimum: 1, maximum: 365 }),
  MAX_ACTIVE_SESSIONS: Type.Integer({ minimum: 1, maximum: 20 }),
  INVITATION_TTL_DAYS: Type.Integer({ minimum: 1, maximum: 365 }),
  JOIN_GRANT_TTL_MINUTES: Type.Integer({ minimum: 5, maximum: 60 }),
  LINE_LINK_TTL_HOURS: Type.Integer({ minimum: 1, maximum: 168 }),
  SMTP_HOST: Type.String({ minLength: 1 }),
  SMTP_PORT: Type.Integer({ minimum: 1, maximum: 65535 }),
  SMTP_SECURE: Type.Boolean(),
  SMTP_USER: Type.String(),
  SMTP_PASSWORD: Type.String(),
  EMAIL_FROM: Type.String({ minLength: 3 })
});

export type AppEnvironment = Static<typeof EnvironmentSchema>;

export function loadEnvironment(
  source: NodeJS.ProcessEnv = process.env
): AppEnvironment {
  const candidate = {
    APP_ENV: source.APP_ENV ?? "development",
    HOST: source.HOST ?? "0.0.0.0",
    PORT: Number(source.PORT ?? "8080"),
    TRUST_PROXY_HOPS: Number(source.TRUST_PROXY_HOPS ?? "0"),
    LOG_LEVEL: source.LOG_LEVEL ?? "info",
    PUBLIC_ORIGIN: source.PUBLIC_ORIGIN ?? "http://127.0.0.1:5500",
    COOKIE_NAME: source.COOKIE_NAME ?? "callnow_session",
    DATABASE_URL:
      source.DATABASE_URL ??
      "postgresql://callnow:callnow@127.0.0.1:5432/callnow",
    AUTH_TOKEN_PEPPER:
      source.AUTH_TOKEN_PEPPER ??
      "development-only-call-now-token-pepper-change-me",
    GOOGLE_OAUTH_CLIENT_ID:
      source.GOOGLE_OAUTH_CLIENT_ID ?? "development-google-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET:
      source.GOOGLE_OAUTH_CLIENT_SECRET ?? "development-google-client-secret",
    GOOGLE_OAUTH_REDIRECT_URI:
      source.GOOGLE_OAUTH_REDIRECT_URI ??
      "http://127.0.0.1:8080/api/v1/auth/google/callback",
    GOOGLE_OAUTH_STATE_TTL_MINUTES: Number(
      source.GOOGLE_OAUTH_STATE_TTL_MINUTES ?? "10"
    ),
    MAGIC_LINK_TTL_MINUTES: Number(source.MAGIC_LINK_TTL_MINUTES ?? "15"),
    SESSION_IDLE_DAYS: Number(source.SESSION_IDLE_DAYS ?? "30"),
    SESSION_ABSOLUTE_DAYS: Number(source.SESSION_ABSOLUTE_DAYS ?? "90"),
    MAX_ACTIVE_SESSIONS: Number(source.MAX_ACTIVE_SESSIONS ?? "5"),
    INVITATION_TTL_DAYS: Number(source.INVITATION_TTL_DAYS ?? "30"),
    JOIN_GRANT_TTL_MINUTES: Number(source.JOIN_GRANT_TTL_MINUTES ?? "15"),
    LINE_LINK_TTL_HOURS: Number(source.LINE_LINK_TTL_HOURS ?? "24"),
    SMTP_HOST: source.SMTP_HOST ?? "127.0.0.1",
    SMTP_PORT: Number(source.SMTP_PORT ?? "1025"),
    SMTP_SECURE: source.SMTP_SECURE === "true",
    SMTP_USER: source.SMTP_USER ?? "",
    SMTP_PASSWORD: source.SMTP_PASSWORD ?? "",
    EMAIL_FROM: source.EMAIL_FROM ?? "Call Now <no-reply@call-now.local>"
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

  if (
    candidate.APP_ENV === "production" &&
    candidate.AUTH_TOKEN_PEPPER.startsWith("development-only-")
  ) {
    throw new Error("AUTH_TOKEN_PEPPER must be replaced in production");
  }

  let googleRedirectUri: URL;
  try {
    googleRedirectUri = new URL(candidate.GOOGLE_OAUTH_REDIRECT_URI);
  } catch {
    throw new Error("GOOGLE_OAUTH_REDIRECT_URI must be a valid URL");
  }

  if (
    candidate.APP_ENV === "production" &&
    googleRedirectUri.protocol !== "https:"
  ) {
    throw new Error("GOOGLE_OAUTH_REDIRECT_URI must use HTTPS in production");
  }

  if (
    candidate.APP_ENV === "production" &&
    (candidate.GOOGLE_OAUTH_CLIENT_ID.startsWith("development-") ||
      candidate.GOOGLE_OAUTH_CLIENT_SECRET.startsWith("development-"))
  ) {
    throw new Error("Google OAuth credentials must be replaced in production");
  }

  return candidate;
}
