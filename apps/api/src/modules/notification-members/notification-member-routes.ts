import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AppEnvironment } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";
import type { AuthService } from "../auth/auth-service.js";
import type { TeamService } from "../teams/team-service.js";
import {
  clearNotificationMemberCookie,
  notificationMemberCookieName,
  setNotificationMemberCookie
} from "./notification-member-cookie.js";
import type {
  NotificationMemberListResult,
  NotificationMemberRecord
} from "./notification-member-repository.js";
import type { NotificationMemberService } from "./notification-member-service.js";

const NotificationMemberResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
  callNowId: Type.String({ pattern: "^CN-[0-9A-HJKMNP-TV-Z]{8}$" }),
  displayName: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([Type.Literal("ACTIVE"), Type.Literal("DISABLED")]),
  createdAt: Type.String(),
  disabledAt: Type.Union([Type.String(), Type.Null()])
});

const SeatResponse = Type.Object({
  seatCount: Type.Integer({ minimum: 1 }),
  additionalSeatLimit: Type.Integer({ minimum: 0 }),
  activeNotificationMemberCount: Type.Integer({ minimum: 0 }),
  occupiedAdditionalSeats: Type.Integer({ minimum: 0 }),
  availableSeats: Type.Integer({ minimum: 0 }),
  pendingSeatCount: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])
});

const ListResponse = Type.Object({
  members: Type.Array(NotificationMemberResponse),
  seats: SeatResponse
});

const CredentialResponse = Type.Object({
  member: NotificationMemberResponse,
  initialPassword: Type.String({ minLength: 20 })
});

export function createNotificationMemberRoutes(
  authService: AuthService,
  teamService: TeamService,
  memberService: NotificationMemberService,
  environment: AppEnvironment
): FastifyPluginAsyncTypebox {
  return async (app) => {
    const authenticateOwner = async (
      request: {
        readonly cookies: Readonly<Record<string, string | undefined>>;
      },
      teamId: string
    ): Promise<string> => {
      const token = request.cookies[environment.COOKIE_NAME];
      if (!token) throw unauthenticatedError();
      const userId = (await authService.authenticate(token)).user.id;
      await teamService.requireOwnerForTeam(userId, teamId);
      return userId;
    };

    const requireSameOrigin = (request: {
      readonly headers: Readonly<Record<string, string | string[] | undefined>>;
    }): void => {
      if (request.headers.origin !== environment.PUBLIC_ORIGIN) {
        throw new AppError(
          "ORIGIN_NOT_ALLOWED",
          "この操作は許可されていません。",
          403
        );
      }
    };

    app.get(
      "/api/v1/teams/:teamId/notification-members",
      {
        schema: {
          params: Type.Object({ teamId: Type.String({ format: "uuid" }) }),
          response: { 200: ListResponse }
        }
      },
      async (request) => {
        await authenticateOwner(request, request.params.teamId);
        return serializeList(await memberService.list(request.params.teamId));
      }
    );

    app.post(
      "/api/v1/teams/:teamId/notification-members",
      {
        schema: {
          params: Type.Object({ teamId: Type.String({ format: "uuid" }) }),
          body: Type.Object({
            displayName: Type.Optional(
              Type.String({ minLength: 1, maxLength: 120 })
            )
          }),
          response: { 201: CredentialResponse }
        }
      },
      async (request, reply) => {
        requireSameOrigin(request);
        const actorUserId = await authenticateOwner(
          request,
          request.params.teamId
        );
        const result = await memberService.create({
          teamId: request.params.teamId,
          actorUserId,
          ...(request.body.displayName
            ? { displayName: request.body.displayName }
            : {})
        });
        await reply.status(201).send({
          member: serializeMember(result.member),
          initialPassword: result.initialPassword
        });
      }
    );

    app.post(
      "/api/v1/teams/:teamId/notification-members/:memberId/password-reset",
      {
        schema: {
          params: Type.Object({
            teamId: Type.String({ format: "uuid" }),
            memberId: Type.String({ format: "uuid" })
          }),
          response: { 200: CredentialResponse }
        }
      },
      async (request) => {
        requireSameOrigin(request);
        const actorUserId = await authenticateOwner(
          request,
          request.params.teamId
        );
        const result = await memberService.resetPassword({
          teamId: request.params.teamId,
          memberId: request.params.memberId,
          actorUserId
        });
        return {
          member: serializeMember(result.member),
          initialPassword: result.initialPassword
        };
      }
    );

    app.delete(
      "/api/v1/teams/:teamId/notification-members/:memberId",
      {
        schema: {
          params: Type.Object({
            teamId: Type.String({ format: "uuid" }),
            memberId: Type.String({ format: "uuid" })
          }),
          response: { 200: ListResponse }
        }
      },
      async (request) => {
        requireSameOrigin(request);
        const actorUserId = await authenticateOwner(
          request,
          request.params.teamId
        );
        return serializeList(
          await memberService.disable({
            teamId: request.params.teamId,
            memberId: request.params.memberId,
            actorUserId
          })
        );
      }
    );

    app.post(
      "/api/v1/notification-members/login",
      {
        config: { rateLimit: { max: 30, timeWindow: "15 minutes" } },
        schema: {
          body: Type.Object({
            callNowId: Type.String({ minLength: 4, maxLength: 16 }),
            password: Type.String({ minLength: 8, maxLength: 128 })
          }),
          response: {
            200: Type.Object({
              member: NotificationMemberResponse,
              team: Type.Object({
                id: Type.String({ format: "uuid" }),
                teamCode: Type.String({ pattern: "^[0-9]{6}$" }),
                name: Type.Union([Type.String(), Type.Null()])
              })
            })
          }
        }
      },
      async (request, reply) => {
        requireSameOrigin(request);
        const result = await memberService.login({
          callNowId: request.body.callNowId,
          password: request.body.password,
          ipAddress: request.ip,
          ...(request.headers["user-agent"]
            ? { userAgent: request.headers["user-agent"] }
            : {})
        });
        setNotificationMemberCookie(reply, environment, result.sessionToken);
        return {
          member: serializeMember(result.member),
          team: {
            id: result.team.id,
            teamCode: result.team.publicCode,
            name: result.team.name
          }
        };
      }
    );

    app.get(
      "/api/v1/notification-members/me",
      {
        schema: {
          response: {
            200: Type.Object({
              member: NotificationMemberResponse,
              team: Type.Object({
                id: Type.String({ format: "uuid" }),
                teamCode: Type.String({ pattern: "^[0-9]{6}$" }),
                name: Type.Union([Type.String(), Type.Null()])
              })
            })
          }
        }
      },
      async (request) => {
        const token =
          request.cookies[notificationMemberCookieName(environment)];
        if (!token) throw unauthenticatedError();
        const result = await memberService.authenticate(token);
        return {
          member: serializeMember(result.member),
          team: {
            id: result.team.id,
            teamCode: result.team.publicCode,
            name: result.team.name
          }
        };
      }
    );

    app.post(
      "/api/v1/notification-members/logout",
      { schema: { response: { 204: Type.Null() } } },
      async (request, reply) => {
        requireSameOrigin(request);
        const token =
          request.cookies[notificationMemberCookieName(environment)];
        if (token) await memberService.logout(token);
        clearNotificationMemberCookie(reply, environment);
        await reply.status(204).send(null);
      }
    );
  };
}

function serializeMember(member: NotificationMemberRecord) {
  return {
    id: member.id,
    callNowId: member.callNowId,
    displayName: member.displayName,
    status: member.status,
    createdAt: member.createdAt.toISOString(),
    disabledAt: member.disabledAt?.toISOString() ?? null
  };
}

function serializeList(result: NotificationMemberListResult) {
  return {
    members: result.members.map(serializeMember),
    seats: result.seats
  };
}

function unauthenticatedError(): AppError {
  return new AppError("UNAUTHENTICATED", "ログインが必要です。", 401);
}
