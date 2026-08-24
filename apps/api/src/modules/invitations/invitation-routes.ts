import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AppEnvironment } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";
import type { AuthService } from "../auth/auth-service.js";
import type { SecurityThrottleService } from "../security/security-throttle-service.js";
import type { InvitationService } from "./invitation-service.js";

const InvitationResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
  status: Type.Union([
    Type.Literal("ACTIVE"),
    Type.Literal("EXHAUSTED"),
    Type.Literal("EXPIRED"),
    Type.Literal("REVOKED"),
    Type.Literal("REPLACED")
  ]),
  maxUses: Type.Integer({ minimum: 1 }),
  usedCount: Type.Integer({ minimum: 0 }),
  expiresAt: Type.String(),
  createdAt: Type.String()
});

const InvitationCredentialResponse = Type.Object({
  invitation: InvitationResponse,
  password: Type.String()
});

const JoinGrantResponse = Type.Object({
  joinToken: Type.String(),
  expiresAt: Type.String()
});

export function createInvitationRoutes(
  authService: AuthService,
  invitationService: InvitationService,
  securityThrottle: SecurityThrottleService,
  environment: AppEnvironment
): FastifyPluginAsyncTypebox {
  return async (app) => {
    const authenticateUserId = async (request: {
      readonly cookies: Readonly<Record<string, string | undefined>>;
    }): Promise<string> => {
      const token = request.cookies[environment.COOKIE_NAME];
      if (!token) {
        throw new AppError("UNAUTHENTICATED", "ログインが必要です。", 401);
      }
      return (await authService.authenticate(token)).user.id;
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
      "/api/v1/teams/current/invitations",
      {
        schema: {
          response: {
            200: Type.Object({ invitations: Type.Array(InvitationResponse) })
          }
        }
      },
      async (request) => {
        const userId = await authenticateUserId(request);
        const invitations = await invitationService.listInvitations(userId);
        return { invitations: invitations.map(serializeInvitation) };
      }
    );

    app.post(
      "/api/v1/teams/current/invitations/reissue",
      {
        schema: {
          response: { 201: InvitationCredentialResponse }
        }
      },
      async (request, reply) => {
        requireSameOrigin(request);
        const userId = await authenticateUserId(request);
        const result =
          await invitationService.reissuePasswordInvitation(userId);
        await reply.status(201).send({
          invitation: serializeInvitation(result.invitation),
          password: result.password
        });
      }
    );

    app.delete(
      "/api/v1/teams/current/invitations/:invitationId",
      {
        schema: {
          params: Type.Object({
            invitationId: Type.String({ format: "uuid" })
          }),
          response: { 204: Type.Null() }
        }
      },
      async (request, reply) => {
        requireSameOrigin(request);
        const userId = await authenticateUserId(request);
        await invitationService.revokeInvitation(
          userId,
          request.params.invitationId
        );
        await reply.status(204).send(null);
      }
    );

    app.post(
      "/api/v1/teams/current/invitations/:invitationId/links",
      {
        schema: {
          params: Type.Object({
            invitationId: Type.String({ format: "uuid" })
          }),
          response: {
            201: Type.Object({
              linkId: Type.String({ format: "uuid" }),
              invitationLink: Type.String(),
              shareText: Type.String(),
              expiresAt: Type.String()
            })
          }
        }
      },
      async (request, reply) => {
        requireSameOrigin(request);
        const userId = await authenticateUserId(request);
        const result = await invitationService.createLineInvitationLink(
          userId,
          request.params.invitationId
        );
        await reply.status(201).send({
          ...result,
          expiresAt: result.expiresAt.toISOString()
        });
      }
    );

    app.delete(
      "/api/v1/teams/current/invitation-links/:linkId",
      {
        schema: {
          params: Type.Object({ linkId: Type.String({ format: "uuid" }) }),
          response: { 204: Type.Null() }
        }
      },
      async (request, reply) => {
        requireSameOrigin(request);
        const userId = await authenticateUserId(request);
        await invitationService.revokeInvitationLink(
          userId,
          request.params.linkId
        );
        await reply.status(204).send(null);
      }
    );

    app.post(
      "/api/v1/join/password/verify",
      {
        config: { rateLimit: { max: 20, timeWindow: "1 hour" } },
        schema: {
          body: Type.Object({
            teamCode: Type.String({ pattern: "^[0-9]{6}$" }),
            password: Type.String({ minLength: 1, maxLength: 200 })
          }),
          response: { 200: JoinGrantResponse }
        }
      },
      async (request) => {
        requireSameOrigin(request);
        const result = await invitationService.verifyPasswordInvitation({
          teamCode: request.body.teamCode,
          password: request.body.password,
          attemptKey: request.ip
        });
        return { ...result, expiresAt: result.expiresAt.toISOString() };
      }
    );

    app.post(
      "/api/v1/join/link/verify",
      {
        config: { rateLimit: { max: 30, timeWindow: "15 minutes" } },
        schema: {
          body: Type.Object({
            token: Type.String({ minLength: 40, maxLength: 100 })
          }),
          response: { 200: JoinGrantResponse }
        }
      },
      async (request) => {
        requireSameOrigin(request);
        await securityThrottle.consume([
          throttleRule("line_use_global", ["all"], 1_000, 1, 5),
          throttleRule("line_use_source", [request.ip], 30, 15, 15),
          throttleRule("line_use_token", [request.body.token], 10, 15, 15),
          throttleRule(
            "line_use_pair",
            [request.body.token, request.ip],
            10,
            15,
            15
          )
        ]);
        const result = await invitationService.verifyLineInvitation(
          request.body.token
        );
        return { ...result, expiresAt: result.expiresAt.toISOString() };
      }
    );

    app.post(
      "/api/v1/join/complete",
      {
        schema: {
          body: Type.Object({
            joinToken: Type.String({ minLength: 40, maxLength: 100 }),
            idempotencyKey: Type.String({ minLength: 16, maxLength: 100 })
          }),
          response: {
            200: Type.Object({
              teamId: Type.String({ format: "uuid" }),
              teamCode: Type.String({ pattern: "^[0-9]{6}$" }),
              membershipId: Type.String({ format: "uuid" }),
              activeMemberCount: Type.Integer({ minimum: 1 }),
              seatLimit: Type.Integer({ minimum: 1 }),
              availableSeats: Type.Integer({ minimum: 0 })
            })
          }
        }
      },
      async (request) => {
        requireSameOrigin(request);
        const userId = await authenticateUserId(request);
        await securityThrottle.consume([
          throttleRule("join_global", ["all"], 1_000, 1, 5),
          throttleRule("join_source", [request.ip], 30, 15, 15),
          throttleRule("join_user", [userId], 20, 15, 15),
          throttleRule("join_grant", [request.body.joinToken], 10, 15, 15)
        ]);
        return invitationService.completeJoin({
          userId,
          joinToken: request.body.joinToken,
          idempotencyKey: request.body.idempotencyKey
        });
      }
    );

    app.delete(
      "/api/v1/teams/current/members/:membershipId",
      {
        schema: {
          params: Type.Object({
            membershipId: Type.String({ format: "uuid" })
          }),
          response: {
            200: Type.Object({
              removedUserId: Type.String({ format: "uuid" }),
              activeMemberCount: Type.Integer({ minimum: 0 }),
              seatLimit: Type.Integer({ minimum: 0 }),
              availableSeats: Type.Integer({ minimum: 0 }),
              pendingSeatLimitApplied: Type.Boolean(),
              invitation: Type.Union([InvitationResponse, Type.Null()]),
              invitationPassword: Type.Union([Type.String(), Type.Null()])
            })
          }
        }
      },
      async (request) => {
        requireSameOrigin(request);
        const userId = await authenticateUserId(request);
        const result = await invitationService.removeMember(
          userId,
          request.params.membershipId
        );
        return {
          ...result,
          invitation: result.invitation
            ? serializeInvitation(result.invitation)
            : null
        };
      }
    );

    app.post(
      "/api/v1/teams/current/leave",
      {
        schema: {
          response: {
            200: Type.Object({
              removedUserId: Type.String({ format: "uuid" }),
              activeMemberCount: Type.Integer({ minimum: 0 }),
              seatLimit: Type.Integer({ minimum: 0 }),
              availableSeats: Type.Integer({ minimum: 0 }),
              pendingSeatLimitApplied: Type.Boolean()
            })
          }
        }
      },
      async (request) => {
        requireSameOrigin(request);
        const userId = await authenticateUserId(request);
        const result = await invitationService.leaveTeam(userId);
        return {
          removedUserId: result.removedUserId,
          activeMemberCount: result.activeMemberCount,
          seatLimit: result.seatLimit,
          availableSeats: result.availableSeats,
          pendingSeatLimitApplied: result.pendingSeatLimitApplied
        };
      }
    );

    app.get(
      "/api/v1/teams/current/audit-events",
      {
        schema: {
          response: {
            200: Type.Object({
              events: Type.Array(
                Type.Object({
                  id: Type.String({ format: "uuid" }),
                  action: Type.String(),
                  actorUserId: Type.Union([
                    Type.String({ format: "uuid" }),
                    Type.Null()
                  ]),
                  targetType: Type.Union([Type.String(), Type.Null()]),
                  targetId: Type.Union([Type.String(), Type.Null()]),
                  metadata: Type.Any(),
                  createdAt: Type.String()
                })
              )
            })
          }
        }
      },
      async (request) => {
        const userId = await authenticateUserId(request);
        const events = await invitationService.listAuditEvents(userId);
        return {
          events: events.map((event) => ({
            ...event,
            createdAt: event.createdAt.toISOString()
          }))
        };
      }
    );
  };
}

function throttleRule(
  scope: string,
  dimensions: readonly string[],
  maximumAttempts: number,
  windowMinutes: number,
  lockMinutes: number
) {
  return { scope, dimensions, maximumAttempts, windowMinutes, lockMinutes };
}

function serializeInvitation(invitation: {
  readonly id: string;
  readonly status: "ACTIVE" | "EXHAUSTED" | "EXPIRED" | "REVOKED" | "REPLACED";
  readonly maxUses: number;
  readonly usedCount: number;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}) {
  return {
    id: invitation.id,
    status: invitation.status,
    maxUses: invitation.maxUses,
    usedCount: invitation.usedCount,
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString()
  };
}
