import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyRequest } from "fastify";
import type { AppEnvironment } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";
import type { AuthService } from "../auth/auth-service.js";
import type { NotificationMemberService } from "../notification-members/notification-member-service.js";
import { notificationMemberCookieName } from "../notification-members/notification-member-cookie.js";
import type { TeamService } from "../teams/team-service.js";
import type {
  DevicePushRegistry,
  PushPrincipal
} from "./device-push-registry.js";

const uuid = Type.String({
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
});
const version = Type.Integer({ minimum: 1, maximum: 2147483646 });
const token = Type.String({
  minLength: 2,
  maxLength: 1024,
  pattern: "^(?:[0-9a-fA-F]{2})+$"
});
const result = Type.Object({
  targetKey: uuid,
  installationId: uuid,
  platform: Type.Literal("APNS"),
  tokenVersion: version,
  status: Type.Union([Type.Literal("ACTIVE"), Type.Literal("REVOKED")]),
  createdAt: Type.String(),
  lastSeenAt: Type.String(),
  rotatedAt: Type.Union([Type.String(), Type.Null()])
});

export function createDevicePushRoutes(
  registry: DevicePushRegistry,
  auth: Pick<AuthService, "authenticate">,
  members: Pick<NotificationMemberService, "authenticate">,
  teams: Pick<TeamService, "requireOwnerForTeam">,
  environment: AppEnvironment
): FastifyPluginAsyncTypebox {
  return async (app) => {
    // This sensitive route scope never logs raw parser, crypto, adapter or auth errors.
    app.setErrorHandler(async (error, _request, reply) => {
      const known = error instanceof AppError;
      const errorStatus =
        error && typeof error === "object" && "statusCode" in error
          ? error.statusCode
          : undefined;
      const status = known
        ? error.statusCode
        : typeof errorStatus === "number" &&
            errorStatus >= 400 &&
            errorStatus < 500
          ? errorStatus
          : 503;
      await reply.status(status).send({
        error: {
          code: known
            ? error.code
            : status < 500
              ? "INVALID_PUSH_REGISTRATION"
              : "PUSH_REGISTRY_UNAVAILABLE",
          message: known ? error.message : "端末の登録を完了できませんでした。"
        }
      });
    });
    app.addHook("onRequest", async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
    });

    for (const kind of ["OWNER", "MEMBER"] as const) {
      const base =
        kind === "OWNER"
          ? "/api/v1/teams/:teamId/push-devices"
          : "/api/v1/notification-members/push-devices";
      const baseParams = kind === "OWNER" ? { teamId: uuid } : {};
      const authenticate = async (
        request: FastifyRequest,
        mutation: boolean
      ): Promise<PushPrincipal> => {
        if (mutation && request.headers.origin !== environment.PUBLIC_ORIGIN)
          throw new AppError(
            "ORIGIN_NOT_ALLOWED",
            "この操作は許可されていません。",
            403
          );
        // Separate routes select the cookie namespace. No ambiguous OWNER/MEMBER fallback.
        const session =
          request.cookies[
            kind === "OWNER"
              ? environment.COOKIE_NAME
              : notificationMemberCookieName(environment)
          ];
        if (!session)
          throw new AppError("UNAUTHENTICATED", "ログインが必要です。", 401);
        if (kind === "MEMBER") {
          const current = await members.authenticate(session);
          return {
            teamId: current.team.id,
            principalKind: kind,
            principalId: current.member.id
          };
        }
        const current = await auth.authenticate(session);
        const teamId = (request.params as { teamId: string }).teamId;
        await teams.requireOwnerForTeam(current.user.id, teamId);
        return { teamId, principalKind: kind, principalId: current.user.id };
      };
      app.post(
        base,
        {
          bodyLimit: 4096,
          schema: {
            params: Type.Object(baseParams),
            body: Type.Object(
              {
                installationId: uuid,
                platform: Type.Literal("APNS"),
                deviceToken: token
              },
              { additionalProperties: false }
            ),
            response: { 201: result }
          }
        },
        async (request, reply) => {
          const scope = await authenticate(request, true);
          const row = await registry.register(
            scope,
            request.body.installationId,
            request.body.deviceToken
          );
          return reply.status(201).send(serialize(row));
        }
      );
      app.get(
        `${base}/:targetKey`,
        {
          schema: {
            params: Type.Object({ ...baseParams, targetKey: uuid }),
            response: { 200: result }
          }
        },
        async (request) =>
          serialize(
            await registry.get(
              await authenticate(request, false),
              request.params.targetKey
            )
          )
      );
      app.put(
        `${base}/:targetKey`,
        {
          bodyLimit: 4096,
          schema: {
            params: Type.Object({ ...baseParams, targetKey: uuid }),
            body: Type.Object(
              { tokenVersion: version, deviceToken: token },
              { additionalProperties: false }
            ),
            response: { 200: result }
          }
        },
        async (request) =>
          serialize(
            await registry.rotate(
              await authenticate(request, true),
              request.params.targetKey,
              request.body.tokenVersion,
              request.body.deviceToken
            )
          )
      );
      app.delete(
        `${base}/:targetKey`,
        {
          bodyLimit: 4096,
          schema: {
            params: Type.Object({ ...baseParams, targetKey: uuid }),
            body: Type.Object(
              { tokenVersion: version },
              { additionalProperties: false }
            ),
            response: { 200: result }
          }
        },
        async (request) =>
          serialize(
            await registry.revoke(
              await authenticate(request, true),
              request.params.targetKey,
              request.body.tokenVersion
            )
          )
      );
    }
  };
}

function serialize(row: Awaited<ReturnType<DevicePushRegistry["get"]>>) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    rotatedAt: row.rotatedAt?.toISOString() ?? null
  };
}
