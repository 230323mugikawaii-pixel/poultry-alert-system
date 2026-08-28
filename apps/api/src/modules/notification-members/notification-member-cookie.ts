import type { FastifyReply } from "fastify";
import type { AppEnvironment } from "../../config/env.js";
import { usesSecureCookies } from "../auth/session-cookie.js";

export function notificationMemberCookieName(
  environment: AppEnvironment
): string {
  return `${environment.COOKIE_NAME}_member`;
}

export function setNotificationMemberCookie(
  reply: FastifyReply,
  environment: AppEnvironment,
  token: string
): void {
  reply.setCookie(notificationMemberCookieName(environment), token, {
    httpOnly: true,
    secure: usesSecureCookies(environment),
    sameSite: "lax",
    path: "/",
    maxAge: environment.SESSION_ABSOLUTE_DAYS * 86_400
  });
}

export function clearNotificationMemberCookie(
  reply: FastifyReply,
  environment: AppEnvironment
): void {
  reply.clearCookie(notificationMemberCookieName(environment), { path: "/" });
}
