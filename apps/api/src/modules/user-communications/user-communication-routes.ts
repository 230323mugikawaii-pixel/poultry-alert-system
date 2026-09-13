import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AppEnvironment } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";
import type { AuthService } from "../auth/auth-service.js";
import type { SecurityThrottleService } from "../security/security-throttle-service.js";
import type { UserNotificationRecord } from "./user-communication-repository.js";
import type { UserCommunicationService } from "./user-communication-service.js";

const Uuid = Type.String({
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
});
const NotificationResponse = Type.Object({
  id: Uuid,
  type: Type.Union([
    Type.Literal("OPERATOR_ANNOUNCEMENT"),
    Type.Literal("SYSTEM"),
    Type.Literal("FEEDBACK_REPLY")
  ]),
  title: Type.String(),
  message: Type.String(),
  createdAt: Type.String(),
  readAt: Type.Union([Type.String(), Type.Null()])
});

export function createUserCommunicationRoutes(
  authService: AuthService,
  service: UserCommunicationService,
  securityThrottle: SecurityThrottleService,
  environment: AppEnvironment
): FastifyPluginAsyncTypebox {
  return async (app) => {
    const authenticate = async (request: {
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
      "/api/v1/notifications",
      {
        schema: {
          response: {
            200: Type.Object({
              notifications: Type.Array(NotificationResponse),
              unreadCount: Type.Integer({ minimum: 0 })
            })
          }
        }
      },
      async (request, reply) => {
        const userId = await authenticate(request);
        const result = await service.listNotifications(userId);
        reply.header("Cache-Control", "no-store");
        return {
          notifications: result.notifications.map(serializeNotification),
          unreadCount: result.unreadCount
        };
      }
    );

    app.post(
      "/api/v1/notifications/:notificationId/read",
      {
        schema: {
          params: Type.Object({ notificationId: Uuid }),
          response: { 200: NotificationResponse }
        }
      },
      async (request) => {
        requireSameOrigin(request);
        const userId = await authenticate(request);
        return serializeNotification(
          await service.markNotificationRead(
            userId,
            request.params.notificationId
          )
        );
      }
    );

    app.post(
      "/api/v1/feedback",
      {
        config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
        schema: {
          body: Type.Object({
            content: Type.String({ minLength: 1, maxLength: 2_000 }),
            teamId: Type.Optional(Uuid)
          }),
          response: {
            201: Type.Object({
              id: Uuid,
              status: Type.Literal("SUBMITTED"),
              createdAt: Type.String()
            })
          }
        }
      },
      async (request, reply) => {
        requireSameOrigin(request);
        const userId = await authenticate(request);
        await securityThrottle.consume(
          [
            throttleRule("feedback_source", [request.ip], 10, 60, 60),
            throttleRule("feedback_user", [userId], 5, 60, 60),
            throttleRule("feedback_pair", [userId, request.ip], 5, 60, 60)
          ],
          {
            code: "FEEDBACK_RATE_LIMITED",
            message: "送信回数が上限に達しました。時間をおいてお試しください。",
            statusCode: 429
          }
        );
        const feedback = await service.submitFeedback({
          userId,
          ...(request.body.teamId ? { teamId: request.body.teamId } : {}),
          message: request.body.content,
          requestId: request.id
        });
        await reply.status(201).send({
          id: feedback.id,
          status: "SUBMITTED",
          createdAt: feedback.createdAt.toISOString()
        });
      }
    );
  };
}

function serializeNotification(notification: UserNotificationRecord) {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    createdAt: notification.createdAt.toISOString(),
    readAt: notification.readAt?.toISOString() ?? null
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
