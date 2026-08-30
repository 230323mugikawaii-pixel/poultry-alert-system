import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AppEnvironment } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";
import type { AuthService } from "../auth/auth-service.js";
import type { InvitationService } from "../invitations/invitation-service.js";
import type { TeamContextRecord } from "./team-repository.js";
import type { TeamService } from "./team-service.js";
import { DEFAULT_MAX_CONFIGURED_SEAT_COUNT } from "./seat-policy.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

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
  keywords: Type.Array(Type.String({ minLength: 1, maxLength: 100 })),
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
    renewalAmountYen: Type.Integer({ minimum: 6000 }),
    currentTermStartedAt: Type.String(),
    currentTermEndsAt: Type.String()
  })
});

const ContractSettingsBody = Type.Object({
  seatCount: Type.Integer({ minimum: 1 }),
  connections: Type.Array(
    Type.Object({
      connectionId: Type.String({ pattern: UUID_PATTERN }),
      keywords: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
        minItems: 1,
        maxItems: 100
      })
    }),
    { minItems: 1, maxItems: 20 }
  ),
  idempotencyKey: Type.String({ minLength: 16, maxLength: 100 })
});

const ContractChangeQuoteResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
  status: Type.Union([Type.Literal("PENDING"), Type.Literal("APPLIED")]),
  previousAnnualAmountYen: Type.Integer({ minimum: 6000 }),
  nextAnnualAmountYen: Type.Integer({ minimum: 6000 }),
  additionalChargeYen: Type.Integer({ minimum: 0 }),
  requiresCheckout: Type.Boolean(),
  seatCount: Type.Integer({ minimum: 1 }),
  keywordCount: Type.Integer({ minimum: 0 }),
  mailConnectionCount: Type.Integer({ minimum: 1 }),
  expiresAt: Type.String()
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

    app.post(
      "/api/v1/teams/:teamId/contract-settings/quote",
      {
        config: { rateLimit: { max: 30, timeWindow: "15 minutes" } },
        schema: {
          params: Type.Object({
            teamId: Type.String({ pattern: UUID_PATTERN })
          }),
          body: Type.Intersect([
            ContractSettingsBody,
            Type.Object({
              seatCount: Type.Integer({
                minimum: 1,
                maximum: maximumSeatCount
              })
            })
          ]),
          response: {
            201: Type.Object({ quote: ContractChangeQuoteResponse })
          }
        }
      },
      async (request, reply) => {
        requireSameOrigin(request);
        const userId = await authenticateUserId(request);
        const quote = await teamService.createContractChangeQuote({
          userId,
          teamId: request.params.teamId,
          seatCount: request.body.seatCount,
          connections: request.body.connections,
          idempotencyKey: request.body.idempotencyKey
        });
        await reply.status(201).send({ quote: serializeContractQuote(quote) });
      }
    );

    app.post(
      "/api/v1/teams/:teamId/contract-settings/quotes/:quoteId/apply",
      {
        config: { rateLimit: { max: 30, timeWindow: "15 minutes" } },
        schema: {
          params: Type.Object({
            teamId: Type.String({ pattern: UUID_PATTERN }),
            quoteId: Type.String({ pattern: UUID_PATTERN })
          }),
          body: Type.Object({
            idempotencyKey: Type.String({ minLength: 16, maxLength: 100 }),
            expectedPreviousAnnualAmountYen: Type.Integer({ minimum: 6000 }),
            expectedNextAnnualAmountYen: Type.Integer({ minimum: 6000 }),
            expectedAdditionalChargeYen: Type.Integer({ minimum: 0 })
          }),
          response: {
            200: Type.Object({
              quote: ContractChangeQuoteResponse,
              team: TeamResponse
            })
          }
        }
      },
      async (request) => {
        requireSameOrigin(request);
        const userId = await authenticateUserId(request);
        const applied = await teamService.applyContractChangeQuote({
          userId,
          teamId: request.params.teamId,
          quoteId: request.params.quoteId,
          idempotencyKey: request.body.idempotencyKey,
          expectedPreviousAnnualAmountYen:
            request.body.expectedPreviousAnnualAmountYen,
          expectedNextAnnualAmountYen: request.body.expectedNextAnnualAmountYen,
          expectedAdditionalChargeYen: request.body.expectedAdditionalChargeYen,
          requestId: request.id
        });
        return {
          quote: serializeContractQuote(applied.quote),
          team: serializeTeam(applied.team)
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
    keywords: [...team.keywords],
    representativeCount: 1 as const,
    seats: team.seatSummary,
    pendingSeatLimit: team.pendingSeatLimit,
    subscription: {
      status: team.subscriptionStatus,
      currentTermAmountYen: team.currentTermAmountYen,
      renewalAmountYen: team.renewalAmountYen,
      currentTermStartedAt: team.currentTermStartedAt.toISOString(),
      currentTermEndsAt: team.currentTermEndsAt.toISOString()
    }
  };
}

function serializeContractQuote(quote: {
  readonly id: string;
  readonly status: "PENDING" | "APPLIED";
  readonly previousAnnualAmountYen: number;
  readonly nextAnnualAmountYen: number;
  readonly additionalChargeYen: number;
  readonly seatCount: number;
  readonly keywordCount: number;
  readonly mailConnectionCount: number;
  readonly expiresAt: Date;
}) {
  return {
    id: quote.id,
    status: quote.status,
    previousAnnualAmountYen: quote.previousAnnualAmountYen,
    nextAnnualAmountYen: quote.nextAnnualAmountYen,
    additionalChargeYen: quote.additionalChargeYen,
    requiresCheckout: quote.additionalChargeYen > 0,
    seatCount: quote.seatCount,
    keywordCount: quote.keywordCount,
    mailConnectionCount: quote.mailConnectionCount,
    expiresAt: quote.expiresAt.toISOString()
  };
}
