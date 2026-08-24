import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AppEnvironment } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";
import type { AuthService } from "../auth/auth-service.js";
import type { InvitationService } from "../invitations/invitation-service.js";
import type { TeamContextRecord } from "./team-repository.js";
import type { TeamService } from "./team-service.js";

const SeatSummaryResponse = Type.Object({
  seatLimit: Type.Integer({ minimum: 0 }),
  activeMemberCount: Type.Integer({ minimum: 0 }),
  availableSeats: Type.Integer({ minimum: 0 }),
  totalUserLimit: Type.Integer({ minimum: 1 }),
  currentUserCount: Type.Integer({ minimum: 1 })
});

const TeamResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
  teamCode: Type.String({ pattern: "^[0-9]{6}$" }),
  name: Type.Union([Type.String(), Type.Null()]),
  role: Type.Union([Type.Literal("OWNER"), Type.Literal("MEMBER")]),
  representativeCount: Type.Literal(1),
  seats: SeatSummaryResponse,
  pendingSeatLimit: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  subscription: Type.Object({
    currentTermAmountYen: Type.Integer({ minimum: 6000 }),
    currentTermStartedAt: Type.String(),
    currentTermEndsAt: Type.String()
  })
});

const IssuedInvitationResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
  maxUses: Type.Integer({ minimum: 1 }),
  usedCount: Type.Integer({ minimum: 0 }),
  expiresAt: Type.String(),
  password: Type.String()
});

export function createTeamRoutes(
  authService: AuthService,
  teamService: TeamService,
  environment: AppEnvironment,
  invitationService?: InvitationService
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

    app.post(
      "/api/v1/teams",
      {
        schema: {
          body: Type.Object({
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
            seatLimit: Type.Integer({ minimum: 0, maximum: 100 }),
            keywords: Type.Optional(
              Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
                maxItems: 100
              })
            )
          }),
          response: {
            201: Type.Object({
              team: TeamResponse,
              invitation: Type.Union([IssuedInvitationResponse, Type.Null()])
            })
          }
        }
      },
      async (request, reply) => {
        requireSameOrigin(request);
        const userId = await authenticateUserId(request);
        const team = await teamService.createTeam({
          ownerUserId: userId,
          ...(request.body.name ? { name: request.body.name } : {}),
          seatLimit: request.body.seatLimit,
          ...(request.body.keywords ? { keywords: request.body.keywords } : {})
        });
        const invitation =
          invitationService && team.seatSummary.availableSeats > 0
            ? await invitationService.issueForTeam(team.teamId, userId)
            : null;
        await reply.status(201).send({
          team: serializeTeam(team),
          invitation: invitation
            ? {
                id: invitation.invitation.id,
                maxUses: invitation.invitation.maxUses,
                usedCount: invitation.invitation.usedCount,
                expiresAt: invitation.invitation.expiresAt.toISOString(),
                password: invitation.password
              }
            : null
        });
      }
    );

    app.get(
      "/api/v1/teams/current",
      { schema: { response: { 200: Type.Object({ team: TeamResponse }) } } },
      async (request) => {
        const userId = await authenticateUserId(request);
        return {
          team: serializeTeam(await teamService.getCurrentTeam(userId))
        };
      }
    );

    app.get(
      "/api/v1/teams/current/members",
      {
        schema: {
          response: {
            200: Type.Object({
              members: Type.Array(
                Type.Object({
                  membershipId: Type.String({ format: "uuid" }),
                  userId: Type.String({ format: "uuid" }),
                  email: Type.String(),
                  displayName: Type.Union([Type.String(), Type.Null()]),
                  role: Type.Union([
                    Type.Literal("OWNER"),
                    Type.Literal("MEMBER")
                  ]),
                  joinedAt: Type.String()
                })
              )
            })
          }
        }
      },
      async (request) => {
        const userId = await authenticateUserId(request);
        const members = await teamService.listMembers(userId);
        return {
          members: members.map((member) => ({
            ...member,
            joinedAt: member.joinedAt.toISOString()
          }))
        };
      }
    );

    app.get(
      "/api/v1/teams/current/subscription",
      { schema: { response: { 200: Type.Object({ team: TeamResponse }) } } },
      async (request) => {
        const userId = await authenticateUserId(request);
        return {
          team: serializeTeam(await teamService.getCurrentTeam(userId))
        };
      }
    );

    app.post(
      "/api/v1/teams/current/subscription/seat-limit-changes",
      {
        schema: {
          body: Type.Object({
            seatLimit: Type.Integer({ minimum: 0, maximum: 100 })
          }),
          response: {
            202: Type.Object({
              changeId: Type.String({ format: "uuid" }),
              status: Type.Union([
                Type.Literal("AWAITING_PAYMENT"),
                Type.Literal("PENDING_CAPACITY"),
                Type.Literal("APPLIED")
              ]),
              previousSeatLimit: Type.Integer({ minimum: 0 }),
              requestedSeatLimit: Type.Integer({ minimum: 0 }),
              activeMemberCount: Type.Integer({ minimum: 0 }),
              availableSeats: Type.Integer({ minimum: 0 }),
              invitation: Type.Union([IssuedInvitationResponse, Type.Null()])
            })
          }
        }
      },
      async (request, reply) => {
        requireSameOrigin(request);
        const userId = await authenticateUserId(request);
        const result = await teamService.requestSeatLimitChange(
          userId,
          request.body.seatLimit
        );
        const invitation =
          invitationService &&
          result.status === "APPLIED" &&
          result.availableSeats > 0
            ? await invitationService.issueForTeam(
                (await teamService.requireOwner(userId)).teamId,
                userId
              )
            : null;
        await reply.status(202).send({
          ...result,
          invitation: invitation
            ? {
                id: invitation.invitation.id,
                maxUses: invitation.invitation.maxUses,
                usedCount: invitation.invitation.usedCount,
                expiresAt: invitation.invitation.expiresAt.toISOString(),
                password: invitation.password
              }
            : null
        });
      }
    );
  };
}

function serializeTeam(team: TeamContextRecord) {
  return {
    id: team.teamId,
    teamCode: team.teamCode,
    name: team.teamName,
    role: team.role,
    representativeCount: 1 as const,
    seats: team.seatSummary,
    pendingSeatLimit: team.pendingSeatLimit,
    subscription: {
      currentTermAmountYen: team.currentTermAmountYen,
      currentTermStartedAt: team.currentTermStartedAt.toISOString(),
      currentTermEndsAt: team.currentTermEndsAt.toISOString()
    }
  };
}
