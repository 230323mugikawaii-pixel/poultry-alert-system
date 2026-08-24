import { buildApp } from "./app.js";
import { loadEnvironment } from "./config/env.js";
import { createDatabaseClient } from "./db/client.js";
import { AuthService } from "./modules/auth/auth-service.js";
import { SmtpMagicLinkEmailSender } from "./modules/auth/email-sender.js";
import { PrismaAuthRepository } from "./modules/auth/prisma-auth-repository.js";
import { InvitationService } from "./modules/invitations/invitation-service.js";
import { PrismaInvitationRepository } from "./modules/invitations/prisma-invitation-repository.js";
import { PrismaTeamRepository } from "./modules/teams/prisma-team-repository.js";
import { TeamService } from "./modules/teams/team-service.js";

const environment = loadEnvironment();
const database = createDatabaseClient(environment.DATABASE_URL);
const emailSender = new SmtpMagicLinkEmailSender({
  host: environment.SMTP_HOST,
  port: environment.SMTP_PORT,
  secure: environment.SMTP_SECURE,
  user: environment.SMTP_USER,
  password: environment.SMTP_PASSWORD,
  from: environment.EMAIL_FROM
});
const authService = new AuthService({
  repository: new PrismaAuthRepository(database),
  emailSender,
  publicOrigin: environment.PUBLIC_ORIGIN,
  tokenPepper: environment.AUTH_TOKEN_PEPPER,
  magicLinkTtlMinutes: environment.MAGIC_LINK_TTL_MINUTES,
  sessionIdleDays: environment.SESSION_IDLE_DAYS,
  sessionAbsoluteDays: environment.SESSION_ABSOLUTE_DAYS,
  maxActiveSessions: environment.MAX_ACTIVE_SESSIONS
});
const teamService = new TeamService({
  repository: new PrismaTeamRepository(database)
});
const invitationService = new InvitationService({
  repository: new PrismaInvitationRepository(database),
  teamService,
  publicOrigin: environment.PUBLIC_ORIGIN,
  tokenPepper: environment.AUTH_TOKEN_PEPPER,
  invitationTtlDays: environment.INVITATION_TTL_DAYS,
  joinGrantTtlMinutes: environment.JOIN_GRANT_TTL_MINUTES,
  lineLinkTtlHours: environment.LINE_LINK_TTL_HOURS
});
const app = await buildApp({
  environment,
  authService,
  teamService,
  invitationService
});
app.addHook("onClose", async () => database.$disconnect());

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: environment.HOST, port: environment.PORT });
} catch (error) {
  app.log.fatal({ err: error }, "API startup failed");
  process.exit(1);
}
