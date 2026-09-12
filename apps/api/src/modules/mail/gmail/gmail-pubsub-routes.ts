import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { AppError } from "../../../lib/app-error.js";
import type { GmailMonitoringService } from "./gmail-monitoring-service.js";
import { GmailMonitoringTransientError } from "./gmail-monitoring-service.js";
import type { PubSubPushAuthenticator } from "./gmail-pubsub-authenticator.js";
import { parseGmailPubSubEnvelope } from "./gmail-pubsub-envelope.js";

export function createGmailPubSubRoutes(
  authenticator: PubSubPushAuthenticator,
  monitoringService: GmailMonitoringService,
  maximumBodyBytes: number
): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post(
      "/api/v1/webhooks/mail/google/pubsub",
      {
        bodyLimit: maximumBodyBytes,
        config: { rateLimit: { max: 600, timeWindow: "1 minute" } }
      },
      async (request, reply) => {
        const contentType = request.headers["content-type"] ?? "";
        if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
          throw new AppError(
            "GMAIL_PUBSUB_CONTENT_TYPE_INVALID",
            "Content-Type must be application/json.",
            415
          );
        }
        await authenticator.authenticate(request.headers.authorization);
        const notification = parseGmailPubSubEnvelope(request.body);
        try {
          await monitoringService.processPushNotification(notification);
        } catch (error) {
          if (error instanceof GmailMonitoringTransientError) {
            throw new AppError(
              "GMAIL_PUBSUB_RETRY_REQUIRED",
              "The notification could not be processed yet.",
              503
            );
          }
          throw error;
        }
        await reply.status(204).send();
      }
    );
  };
}
