import type { FastifyReply } from "fastify";
import type { AppEnvironment } from "../../config/env.js";

export function setSessionCookie(
  reply: FastifyReply,
  environment: AppEnvironment,
  sessionToken: string
): void {
  reply.setCookie(environment.COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: usesSecureCookies(environment),
    sameSite: "lax",
    path: "/",
    maxAge: environment.SESSION_ABSOLUTE_DAYS * 86_400
  });
}

export function clearSessionCookie(
  reply: FastifyReply,
  environment: AppEnvironment
): void {
  reply.clearCookie(environment.COOKIE_NAME, { path: "/" });
}

export function usesSecureCookies(environment: AppEnvironment): boolean {
  return (
    environment.APP_ENV === "production" || environment.APP_ENV === "staging"
  );
}
