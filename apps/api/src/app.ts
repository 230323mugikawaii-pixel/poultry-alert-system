import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppEnvironment } from "./config/env.js";
import { AppError } from "./lib/app-error.js";
import type { AlertService } from "./modules/alerts/alert-service.js";
import { createAlertRoutes } from "./modules/alerts/alert-routes.js";
import { createNotificationTestRoutes } from "./modules/alerts/notification-test-routes.js";
import type { NotificationTestService } from "./modules/alerts/notification-test-service.js";
import type { AuthService } from "./modules/auth/auth-service.js";
import { createAuthRoutes } from "./modules/auth/auth-routes.js";
import type { GoogleAuthService } from "./modules/auth/google-auth-service.js";
import { createGoogleAuthRoutes } from "./modules/auth/google-auth-routes.js";
import { createPrimaryAuthRoutes } from "./modules/auth/primary-auth-routes.js";
import type { PrimaryAuthService } from "./modules/auth/primary-auth-service.js";
import type { MailConnectionService } from "./modules/mail/mail-connection-service.js";
import { createMailConnectionRoutes } from "./modules/mail/mail-connection-routes.js";
import type { InvitationService } from "./modules/invitations/invitation-service.js";
import type { NotificationMemberService } from "./modules/notification-members/notification-member-service.js";
import { createNotificationMemberRoutes } from "./modules/notification-members/notification-member-routes.js";
import type { OwnerOnboardingService } from "./modules/onboarding/owner-onboarding-service.js";
import { createOwnerOnboardingRoutes } from "./modules/onboarding/owner-onboarding-routes.js";
import type { SecurityThrottleService } from "./modules/security/security-throttle-service.js";
import { createInvitationRoutes } from "./modules/invitations/invitation-routes.js";
import type { TeamService } from "./modules/teams/team-service.js";
import { createTeamRoutes } from "./modules/teams/team-routes.js";
import type { UserCommunicationService } from "./modules/user-communications/user-communication-service.js";
import { createUserCommunicationRoutes } from "./modules/user-communications/user-communication-routes.js";
import { createSystemRoutes } from "./routes/system.js";

export interface BuildAppOptions {
  readonly environment: AppEnvironment;
  readonly logger?: boolean;
  readonly authService?: AuthService;
  readonly googleAuthService?: GoogleAuthService;
  readonly primaryAuthService?: PrimaryAuthService;
  readonly mailConnectionService?: MailConnectionService;
  readonly teamService?: TeamService;
  readonly invitationService?: InvitationService;
  readonly notificationMemberService?: NotificationMemberService;
  readonly ownerOnboardingService?: OwnerOnboardingService;
  readonly alertService?: AlertService;
  readonly notificationTestService?: NotificationTestService;
  readonly userCommunicationService?: UserCommunicationService;
  readonly securityThrottleService?: SecurityThrottleService;
  readonly readinessCheck?: () => Promise<void>;
}

export async function buildApp(
  options: BuildAppOptions
): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: options.environment.LOG_LEVEL,
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                "req.url",
                "res.headers.set-cookie",
                "query.code",
                "query.state",
                "body.token",
                "body.password",
                "body.magicLink",
                "body.joinToken",
                "body.invitationPassword",
                "body.refreshToken",
                "body.authorizationCode",
                "body.code",
                "body.state",
                "body.user",
                "body.content"
              ],
              censor: "[REDACTED]"
            }
          },
    trustProxy:
      options.environment.TRUST_PROXY_HOPS === 0
        ? false
        : (_address: string, hop: number) =>
            hop < options.environment.TRUST_PROXY_HOPS,
    requestIdHeader: "x-request-id"
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.setValidatorCompiler(TypeBoxValidatorCompiler);

  await app.register(cookie);
  await app.register(cors, {
    origin: options.environment.PUBLIC_ORIGIN,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]
  });
  await app.register(helmet, {
    contentSecurityPolicy: false
  });
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
    errorResponseBuilder: (_request, context) =>
      new AppError(
        "RATE_LIMITED",
        "リクエストが多すぎます。しばらく待ってからお試しください。",
        context.statusCode
      )
  });

  app.setNotFoundHandler(async (_request, reply) => {
    await reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found."
      }
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof AppError) {
      await reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          ...(error.details ? { details: error.details } : {})
        }
      });
      return;
    }

    if (error instanceof Error && "validation" in error && error.validation) {
      await reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "The request is invalid.",
          requestId: request.id
        }
      });
      return;
    }

    request.log.error({ err: error }, "Unhandled request error");
    await reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
        requestId: request.id
      }
    });
  });

  await app.register(createSystemRoutes(options.readinessCheck));

  if (options.authService) {
    if (!options.securityThrottleService) {
      throw new Error("securityThrottleService is required for authentication");
    }
    await app.register(
      createAuthRoutes(
        options.authService,
        options.securityThrottleService,
        options.environment
      )
    );
  }

  if (options.primaryAuthService && options.authService) {
    if (!options.securityThrottleService) {
      throw new Error(
        "securityThrottleService is required for primary authentication"
      );
    }
    await app.register(
      createPrimaryAuthRoutes(
        options.primaryAuthService,
        options.authService,
        options.securityThrottleService,
        options.environment
      )
    );
  } else if (options.googleAuthService && options.authService) {
    if (!options.securityThrottleService) {
      throw new Error(
        "securityThrottleService is required for Google authentication"
      );
    }
    await app.register(
      createGoogleAuthRoutes(
        options.googleAuthService,
        options.authService,
        options.securityThrottleService,
        options.environment
      )
    );
  }

  if (
    (options.googleAuthService || options.primaryAuthService) &&
    !options.authService
  ) {
    throw new Error("authService is required for Google authentication");
  }

  if (
    options.authService &&
    options.teamService &&
    options.notificationTestService
  ) {
    if (!options.securityThrottleService) {
      throw new Error(
        "securityThrottleService is required for notification tests"
      );
    }
    await app.register(
      createNotificationTestRoutes(
        options.authService,
        options.teamService,
        options.notificationTestService,
        options.securityThrottleService,
        options.environment
      )
    );
  }

  if (options.authService && options.teamService) {
    await app.register(
      createTeamRoutes(
        options.authService,
        options.teamService,
        options.environment,
        options.invitationService
      )
    );
  }

  if (options.authService && options.ownerOnboardingService) {
    if (!options.securityThrottleService) {
      throw new Error(
        "securityThrottleService is required for owner onboarding"
      );
    }
    await app.register(
      createOwnerOnboardingRoutes(
        options.authService,
        options.ownerOnboardingService,
        options.securityThrottleService,
        options.environment
      )
    );
  }

  if (
    options.authService &&
    options.teamService &&
    options.mailConnectionService
  ) {
    if (!options.securityThrottleService) {
      throw new Error("securityThrottleService is required for mail OAuth");
    }
    await app.register(
      createMailConnectionRoutes(
        options.authService,
        options.teamService,
        options.mailConnectionService,
        options.securityThrottleService,
        options.environment,
        options.ownerOnboardingService
      )
    );
  }

  if (options.authService && options.invitationService) {
    if (!options.securityThrottleService) {
      throw new Error("securityThrottleService is required for invitations");
    }
    await app.register(
      createInvitationRoutes(
        options.authService,
        options.invitationService,
        options.securityThrottleService,
        options.environment
      )
    );
  }

  if (
    options.authService &&
    options.teamService &&
    options.notificationMemberService
  ) {
    await app.register(
      createNotificationMemberRoutes(
        options.authService,
        options.teamService,
        options.notificationMemberService,
        options.environment
      )
    );
  }

  if (
    options.authService &&
    options.teamService &&
    options.notificationMemberService &&
    options.alertService
  ) {
    await app.register(
      createAlertRoutes(
        options.authService,
        options.teamService,
        options.notificationMemberService,
        options.alertService,
        options.environment
      )
    );
  }

  if (options.authService && options.userCommunicationService) {
    if (!options.securityThrottleService) {
      throw new Error(
        "securityThrottleService is required for user communications"
      );
    }
    await app.register(
      createUserCommunicationRoutes(
        options.authService,
        options.userCommunicationService,
        options.securityThrottleService,
        options.environment
      )
    );
  }

  return app;
}
