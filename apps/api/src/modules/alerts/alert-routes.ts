import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AppEnvironment } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";
import type { AuthService } from "../auth/auth-service.js";
import type { NotificationMemberAuthentication } from "../notification-members/notification-member-repository.js";
import { notificationMemberCookieName } from "../notification-members/notification-member-cookie.js";
import type { NotificationMemberService } from "../notification-members/notification-member-service.js";
import type { TeamService } from "../teams/team-service.js";
import type { AlertRecord } from "./alert-repository.js";
import type { AlertService } from "./alert-service.js";

const Uuid = Type.String({
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
});
const AlertResponse = Type.Object({
  id: Uuid,
  kind: Type.Union([Type.Literal("REAL"), Type.Literal("TEST")]),
  status: Type.Union([
    Type.Literal("ACTIVE"),
    Type.Literal("ACKNOWLEDGED"),
    Type.Literal("RESOLVED")
  ]),
  detectedAt: Type.String(),
  matchedKeyword: Type.String({ minLength: 1, maxLength: 100 }),
  source: Type.Object({
    connectionId: Uuid,
    provider: Type.Union([Type.Literal("GOOGLE"), Type.Literal("MICROSOFT")])
  }),
  acknowledgedAt: Type.Union([Type.String(), Type.Null()]),
  acknowledgedBy: Type.Union([
    Type.Literal("OWNER"),
    Type.Literal("NOTIFICATION_MEMBER"),
    Type.Null()
  ]),
  acknowledgedByName: Type.Union([
    Type.String({ minLength: 1, maxLength: 100 }),
    Type.Null()
  ]),
  readAt: Type.Union([Type.String(), Type.Null()]),
  resolvedAt: Type.Union([Type.String(), Type.Null()]),
  recipientCount: Type.Integer({ minimum: 1 }),
  updatedAt: Type.String()
});

const AlertListResponse = Type.Object({ alerts: Type.Array(AlertResponse) });
const AlertActionResponse = Type.Object({
  alert: AlertResponse,
  alreadyAcknowledged: Type.Optional(Type.Boolean()),
  alreadyResolved: Type.Optional(Type.Boolean())
});
const TeamParams = Type.Object({ teamId: Uuid });
const AlertParams = Type.Object({
  teamId: Uuid,
  alertId: Uuid
});
const MemberAlertParams = Type.Object({
  alertId: Uuid
});

export function createAlertRoutes(
  authService: AuthService,
  teamService: TeamService,
  memberService: NotificationMemberService,
  alertService: AlertService,
  environment: AppEnvironment
): FastifyPluginAsyncTypebox {
  return async (app) => {
    const authenticateOwner = async (
      request: FastifyRequest,
      teamId: string
    ): Promise<string> => {
      const token = request.cookies[environment.COOKIE_NAME];
      if (!token) throw unauthenticatedError();
      const userId = (await authService.authenticate(token)).user.id;
      await teamService.requireOwnerForTeam(userId, teamId);
      return userId;
    };

    const authenticateMember = async (
      request: FastifyRequest
    ): Promise<NotificationMemberAuthentication> => {
      const token = request.cookies[notificationMemberCookieName(environment)];
      if (!token) throw unauthenticatedError();
      return memberService.authenticate(token);
    };

    const requireSameOrigin = (request: FastifyRequest): void => {
      if (request.headers.origin !== environment.PUBLIC_ORIGIN) {
        throw new AppError(
          "ORIGIN_NOT_ALLOWED",
          "この操作は許可されていません。",
          403
        );
      }
    };

    app.get(
      "/api/v1/teams/:teamId/alerts",
      {
        schema: {
          params: TeamParams,
          response: { 200: AlertListResponse }
        }
      },
      async (request) => {
        const userId = await authenticateOwner(request, request.params.teamId);
        return serializeAlerts(
          await alertService.listForOwner(request.params.teamId, userId)
        );
      }
    );

    app.get(
      "/api/v1/teams/:teamId/alerts/events",
      { schema: { params: TeamParams } },
      async (request, reply) => {
        requireSameOrigin(request);
        await authenticateOwner(request, request.params.teamId);
        startAlertStream(request, reply, environment, async () => {
          const userId = await authenticateOwner(
            request,
            request.params.teamId
          );
          return serializeAlerts(
            await alertService.listForOwner(request.params.teamId, userId)
          );
        });
      }
    );

    app.post(
      "/api/v1/teams/:teamId/alerts/:alertId/acknowledge",
      {
        schema: {
          params: AlertParams,
          response: { 200: AlertActionResponse }
        }
      },
      async (request) => {
        requireSameOrigin(request);
        const userId = await authenticateOwner(request, request.params.teamId);
        const result = await alertService.acknowledgeByOwner({
          teamId: request.params.teamId,
          alertId: request.params.alertId,
          userId
        });
        return {
          alert: serializeAlert(result.alert),
          alreadyAcknowledged: result.alreadyAcknowledged
        };
      }
    );

    app.post(
      "/api/v1/teams/:teamId/alerts/:alertId/resolve",
      {
        schema: {
          params: AlertParams,
          response: { 200: AlertActionResponse }
        }
      },
      async (request) => {
        requireSameOrigin(request);
        const userId = await authenticateOwner(request, request.params.teamId);
        const result = await alertService.resolveByOwner({
          teamId: request.params.teamId,
          alertId: request.params.alertId,
          userId
        });
        return {
          alert: serializeAlert(result.alert),
          alreadyResolved: result.alreadyResolved
        };
      }
    );

    app.post(
      "/api/v1/teams/:teamId/alerts/:alertId/read",
      {
        schema: {
          params: AlertParams,
          response: { 200: AlertResponse }
        }
      },
      async (request) => {
        requireSameOrigin(request);
        const userId = await authenticateOwner(request, request.params.teamId);
        return serializeAlert(
          await alertService.markReadByOwner({
            teamId: request.params.teamId,
            alertId: request.params.alertId,
            userId
          })
        );
      }
    );

    app.get(
      "/api/v1/notification-members/alerts",
      { schema: { response: { 200: AlertListResponse } } },
      async (request) => {
        const authenticated = await authenticateMember(request);
        return serializeAlerts(
          await alertService.listForNotificationMember(
            authenticated.team.id,
            authenticated.member.id
          )
        );
      }
    );

    app.get(
      "/api/v1/notification-members/alerts/events",
      async (request, reply) => {
        requireSameOrigin(request);
        await authenticateMember(request);
        startAlertStream(request, reply, environment, async () => {
          const authenticated = await authenticateMember(request);
          return serializeAlerts(
            await alertService.listForNotificationMember(
              authenticated.team.id,
              authenticated.member.id
            )
          );
        });
      }
    );

    app.post(
      "/api/v1/notification-members/alerts/:alertId/acknowledge",
      {
        schema: {
          params: MemberAlertParams,
          response: { 200: AlertActionResponse }
        }
      },
      async (request) => {
        requireSameOrigin(request);
        const authenticated = await authenticateMember(request);
        const result = await alertService.acknowledgeByNotificationMember({
          teamId: authenticated.team.id,
          alertId: request.params.alertId,
          memberId: authenticated.member.id
        });
        return {
          alert: serializeAlert(result.alert),
          alreadyAcknowledged: result.alreadyAcknowledged
        };
      }
    );

    app.post(
      "/api/v1/notification-members/alerts/:alertId/read",
      {
        schema: {
          params: MemberAlertParams,
          response: { 200: AlertResponse }
        }
      },
      async (request) => {
        requireSameOrigin(request);
        const authenticated = await authenticateMember(request);
        return serializeAlert(
          await alertService.markReadByNotificationMember({
            teamId: authenticated.team.id,
            alertId: request.params.alertId,
            memberId: authenticated.member.id
          })
        );
      }
    );
  };
}

function startAlertStream(
  request: FastifyRequest,
  reply: FastifyReply,
  environment: AppEnvironment,
  load: () => Promise<ReturnType<typeof serializeAlerts>>
): void {
  reply.hijack();
  const response = reply.raw;
  response.statusCode = 200;
  response.setHeader("Access-Control-Allow-Origin", environment.PUBLIC_ORIGIN);
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Vary", "Origin");
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();
  response.write("retry: 5000\n\n");

  let closed = false;
  let previousPayload = "";
  let pollRunning = false;
  const poll = async (): Promise<void> => {
    if (closed || pollRunning) return;
    pollRunning = true;
    try {
      const payload = JSON.stringify(await load());
      if (payload !== previousPayload) {
        previousPayload = payload;
        response.write(`event: alerts\ndata: ${payload}\n\n`);
      } else {
        response.write(": keep-alive\n\n");
      }
    } catch (error) {
      if (isSessionEndedError(error)) {
        response.write(
          'event: session-ended\ndata: {"reason":"UNAUTHENTICATED"}\n\n'
        );
      } else {
        request.log.error(
          { err: error, requestId: request.id },
          "Alert stream polling failed"
        );
        response.write(
          'event: stream-error\ndata: {"reason":"TEMPORARY_UNAVAILABLE"}\n\n'
        );
      }
      response.end();
    } finally {
      pollRunning = false;
    }
  };
  void poll();
  const timer = setInterval(() => void poll(), 5_000);
  request.raw.once("close", () => {
    closed = true;
    clearInterval(timer);
  });
}

function isSessionEndedError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.code === "UNAUTHENTICATED" || error.statusCode === 401)
  );
}

function serializeAlerts(alerts: readonly AlertRecord[]) {
  return { alerts: alerts.map(serializeAlert) };
}

function serializeAlert(alert: AlertRecord) {
  return {
    id: alert.id,
    kind: alert.kind,
    status: alert.status,
    detectedAt: alert.detectedAt.toISOString(),
    matchedKeyword: alert.matchedKeyword,
    source: {
      connectionId: alert.sourceMailConnectionId,
      provider: alert.sourceProvider
    },
    acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: alert.acknowledgedBy,
    acknowledgedByName: alert.acknowledgedByName,
    readAt: alert.readAt?.toISOString() ?? null,
    resolvedAt: alert.resolvedAt?.toISOString() ?? null,
    recipientCount: alert.recipientCount,
    updatedAt: alert.updatedAt.toISOString()
  };
}

function unauthenticatedError(): AppError {
  return new AppError("UNAUTHENTICATED", "ログインが必要です。", 401);
}
