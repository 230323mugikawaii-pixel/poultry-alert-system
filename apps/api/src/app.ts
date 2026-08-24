import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppEnvironment } from "./config/env.js";
import { AppError } from "./lib/app-error.js";
import type { AuthService } from "./modules/auth/auth-service.js";
import { createAuthRoutes } from "./modules/auth/auth-routes.js";
import type { InvitationService } from "./modules/invitations/invitation-service.js";
import { createInvitationRoutes } from "./modules/invitations/invitation-routes.js";
import type { TeamService } from "./modules/teams/team-service.js";
import { createTeamRoutes } from "./modules/teams/team-routes.js";
import { systemRoutes } from "./routes/system.js";

export interface BuildAppOptions {
  readonly environment: AppEnvironment;
  readonly logger?: boolean;
  readonly authService?: AuthService;
  readonly teamService?: TeamService;
  readonly invitationService?: InvitationService;
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
                "res.headers.set-cookie",
                "body.token",
                "body.password",
                "body.magicLink",
                "body.joinToken",
                "body.invitationPassword"
              ],
              censor: "[REDACTED]"
            }
          },
    trustProxy: true,
    requestIdHeader: "x-request-id"
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.setValidatorCompiler(TypeBoxValidatorCompiler);

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: false
  });
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute"
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

  await app.register(systemRoutes);

  if (options.authService) {
    await app.register(
      createAuthRoutes(options.authService, options.environment)
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

  if (options.authService && options.invitationService) {
    await app.register(
      createInvitationRoutes(
        options.authService,
        options.invitationService,
        options.environment
      )
    );
  }

  return app;
}
