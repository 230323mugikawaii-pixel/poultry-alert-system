import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AppEnvironment } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";
import type { AuthService } from "../auth/auth-service.js";
import type { SecurityThrottleService } from "../security/security-throttle-service.js";
import type { TeamService } from "../teams/team-service.js";
import type { NotificationTestRecord } from "./notification-test-repository.js";
import type { NotificationTestService } from "./notification-test-service.js";

const Uuid = Type.String({
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
});
const TeamParams = Type.Object({ teamId: Uuid });
const TestParams = Type.Object({ teamId: Uuid, testId: Uuid });
const RequestIdentity = Type.Object({
  requestId: Type.String({ minLength: 1, maxLength: 100 })
});
const NotificationTestResponse = Type.Object({
  id: Uuid,
  status: Type.Union([
    Type.Literal("PENDING"),
    Type.Literal("DETECTED"),
    Type.Literal("ALERT_CREATED"),
    Type.Literal("EXPIRED"),
    Type.Literal("FAILED")
  ]),
  sourceMailConnectionId: Uuid,
  keyword: Type.String({ minLength: 1, maxLength: 100 }),
  requestId: Type.String({ minLength: 1, maxLength: 100 }),
  expiresAt: Type.String(),
  detectedAt: Type.Union([Type.String(), Type.Null()]),
  alertId: Type.Union([Uuid, Type.Null()]),
  completedAt: Type.Union([Type.String(), Type.Null()])
});
const StartResponse = Type.Object({
  test: NotificationTestResponse,
  created: Type.Boolean()
});
const ConfirmResponse = Type.Object({
  test: NotificationTestResponse,
  alertCreated: Type.Boolean()
});

export function createNotificationTestRoutes(
  authService: AuthService,
  teamService: TeamService,
  service: NotificationTestService,
  securityThrottle: SecurityThrottleService,
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
      if (!token) {
        throw new AppError("UNAUTHENTICATED", "ログインが必要です。", 401);
      }
      const userId = (await authService.authenticate(token)).user.id;
      await teamService.requireOwnerForTeam(userId, teamId);
      return userId;
    };

    const requireSameOrigin = (origin: string | undefined): void => {
      if (origin !== environment.PUBLIC_ORIGIN) {
        throw new AppError(
          "ORIGIN_NOT_ALLOWED",
          "この操作は許可されていません。",
          403
        );
      }
    };

    app.post(
      "/api/v1/teams/:teamId/notification-tests",
      {
        schema: {
          params: TeamParams,
          body: Type.Object({
            mailConnectionId: Uuid,
            keyword: Type.String({ minLength: 1, maxLength: 100 })
          }),
          response: { 200: StartResponse, 201: StartResponse }
        }
      },
      async (request, reply) => {
        requireSameOrigin(request.headers.origin);
        const userId = await authenticateOwner(request, request.params.teamId);
        await securityThrottle.consume(
          [
            throttleRule("notification_test_team", [request.params.teamId], 3),
            throttleRule("notification_test_owner", [userId], 3),
            throttleRule("notification_test_source", [request.ip], 12)
          ],
          {
            code: "NOTIFICATION_TEST_RATE_LIMITED",
            message:
              "通知テストが続いています。少し時間をおいてお試しください。",
            statusCode: 429
          }
        );
        const result = await service.start({
          teamId: request.params.teamId,
          actorUserId: userId,
          sourceMailConnectionId: request.body.mailConnectionId,
          keyword: request.body.keyword
        });
        reply.header("Cache-Control", "no-store");
        await reply.status(result.created ? 201 : 200).send({
          test: serializeTest(result.test),
          created: result.created
        });
      }
    );

    app.get(
      "/api/v1/teams/:teamId/notification-tests/:testId",
      {
        schema: {
          params: TestParams,
          response: { 200: NotificationTestResponse }
        }
      },
      async (request, reply) => {
        const userId = await authenticateOwner(request, request.params.teamId);
        const test = await service.getForOwner({
          teamId: request.params.teamId,
          testId: request.params.testId,
          actorUserId: userId
        });
        reply.header("Cache-Control", "no-store");
        return serializeTest(test);
      }
    );

    app.post(
      "/api/v1/teams/:teamId/notification-tests/:testId/confirm",
      {
        schema: {
          params: TestParams,
          body: RequestIdentity,
          response: { 200: ConfirmResponse }
        }
      },
      async (request, reply) => {
        requireSameOrigin(request.headers.origin);
        const userId = await authenticateOwner(request, request.params.teamId);
        const result = await service.confirm({
          teamId: request.params.teamId,
          testId: request.params.testId,
          actorUserId: userId,
          requestId: request.body.requestId
        });
        reply.header("Cache-Control", "no-store");
        return {
          test: serializeTest(result.test),
          alertCreated: result.created
        };
      }
    );

    app.post(
      "/api/v1/teams/:teamId/notification-tests/:testId/fail",
      {
        schema: {
          params: TestParams,
          body: Type.Intersect([
            RequestIdentity,
            Type.Object({
              reasonCode: Type.Union([
                Type.Literal("DELIVERY_REQUEST_FAILED"),
                Type.Literal("DETECTION_STATUS_FAILED")
              ])
            })
          ]),
          response: { 200: NotificationTestResponse }
        }
      },
      async (request, reply) => {
        requireSameOrigin(request.headers.origin);
        const userId = await authenticateOwner(request, request.params.teamId);
        const test = await service.markFailed({
          teamId: request.params.teamId,
          testId: request.params.testId,
          actorUserId: userId,
          requestId: request.body.requestId,
          reasonCode: request.body.reasonCode
        });
        reply.header("Cache-Control", "no-store");
        return serializeTest(test);
      }
    );

    app.post(
      "/api/v1/teams/:teamId/notification-tests/:testId/expire",
      {
        schema: {
          params: TestParams,
          body: RequestIdentity,
          response: { 200: NotificationTestResponse }
        }
      },
      async (request, reply) => {
        requireSameOrigin(request.headers.origin);
        const userId = await authenticateOwner(request, request.params.teamId);
        const test = await service.markExpired({
          teamId: request.params.teamId,
          testId: request.params.testId,
          actorUserId: userId,
          requestId: request.body.requestId
        });
        reply.header("Cache-Control", "no-store");
        return serializeTest(test);
      }
    );
  };
}

function serializeTest(test: NotificationTestRecord) {
  return {
    id: test.id,
    status: test.status,
    sourceMailConnectionId: test.sourceMailConnectionId,
    keyword: test.keyword,
    requestId: test.requestId,
    expiresAt: test.expiresAt.toISOString(),
    detectedAt: test.detectedAt?.toISOString() ?? null,
    alertId: test.alertId,
    completedAt: test.completedAt?.toISOString() ?? null
  };
}

function throttleRule(
  scope: string,
  dimensions: readonly string[],
  maximumAttempts: number
) {
  return {
    scope,
    dimensions,
    maximumAttempts,
    windowMinutes: 10,
    lockMinutes: 10
  };
}
