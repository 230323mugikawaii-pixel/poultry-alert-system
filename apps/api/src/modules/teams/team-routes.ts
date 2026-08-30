import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AppEnvironment } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";
import type { AuthService } from "../auth/auth-service.js";
import type { InvitationService } from "../invitations/invitation-service.js";
import type { TeamContextRecord } from "./team-repository.js";
import type { TeamService } from "./team-service.js";
import { DEFAULT_MAX_CONFIGURED_SEAT_COUNT } from "./seat-policy.js";

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
    status: Type.Union([
      Type.Literal("ACTIVE"),
      Type.Literal("PAST_DUE"),
      Type.Literal("CANCELED")
    ]),
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
  const maximumSeatCount =
    environment.MAX_CONFIGURED_SEAT_COUNT ?? DEFAULT_MAX_CONFIGURED_SEAT_COUNT;
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
      "/api/v1/teams/bootstrap",
      {
        config: { rateLimit: { max: 20, timeWindow: "15 minutes" } },
        schema: {
          body: Type.Object({
            keywords: Type.Optional(
              Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
                maxItems: 100
              })
            )
          }),
          response: {
            200: Type.Object({ team: TeamResponse })
          }
        }
      },
      async (request) => {
        requireSameOrigin(request);
        const userId = await authenticateUserId(request);
        const team = await teamService.ensureInitialTeamForUser({
          userId,
          ...(request.body.keywords ? { keywords: request.body.keywords } : {})
        });
        return { team: serializeTeam(team) };
      }
    );

    app.post(
      "/api/v1/teams",
      {
        schema: {
          body: Type.Object({
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
            seatLimit: Type.Integer({
              minimum: 0,
              maximum: maximumSeatCount - 1
            }),
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
        const credential =
          invitationService && request.body.seatLimit > 0
            ? await invitationService.preparePasswordInvitation()
            : null;
        const created = await teamService.createTeam(
          {
            ownerUserId: userId,
            ...(request.body.name ? { name: request.body.name } : {}),
            seatLimit: request.body.seatLimit,
            ...(request.body.keywords
              ? { keywords: request.body.keywords }
              : {})
          },
          credential
            ? {
                passwordHash: credential.passwordHash,
                expiresAt: credential.expiresAt
              }
            : null
        );
        await reply.status(201).send({
          team: serializeTeam(created.team),
          invitation:
            created.invitation && credential
              ? {
                  id: created.invitation.id,
                  maxUses: created.invitation.maxUses,
                  usedCount: created.invitation.usedCount,
                  expiresAt: created.invitation.expiresAt.toISOString(),
                  password: credential.password
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
            seatLimit: Type.Integer({
              minimum: 0,
              maximum: maximumSeatCount - 1
            })
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
        const credential = invitationService
          ? await invitationService.preparePasswordInvitation()
          : null;
        const result = await teamService.requestSeatLimitChange(
          userId,
          request.body.seatLimit,
          credential
            ? {
                passwordHash: credential.passwordHash,
                expiresAt: credential.expiresAt
              }
            : null
        );
        await reply.status(202).send({
          ...result,
          invitation:
            result.invitation && credential
              ? {
                  id: result.invitation.id,
                  maxUses: result.invitation.maxUses,
                  usedCount: result.invitation.usedCount,
                  expiresAt: result.invitation.expiresAt.toISOString(),
                  password: credential.password
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
      status: team.subscriptionStatus,
      currentTermAmountYen: team.currentTermAmountYen,
      currentTermStartedAt: team.currentTermStartedAt.toISOString(),
      currentTermEndsAt: team.currentTermEndsAt.toISOString()
    }
  };
}
