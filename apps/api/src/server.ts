import { config as loadDotenv } from "dotenv";
import { buildApp } from "./app.js";
import { loadEnvironment } from "./config/env.js";
import { createDatabaseClient } from "./db/client.js";
import { AuthService } from "./modules/auth/auth-service.js";
import { SmtpMagicLinkEmailSender } from "./modules/auth/email-sender.js";
import { GoogleAuthService } from "./modules/auth/google-auth-service.js";
import { GoogleOAuthClient } from "./modules/auth/google-oauth-client.js";
import { PrismaAuthRepository } from "./modules/auth/prisma-auth-repository.js";
import { GmailConnectionService } from "./modules/gmail/gmail-connection-service.js";
import { GoogleGmailOAuthClient } from "./modules/gmail/gmail-oauth-client.js";
import { getGmailProviderAvailability } from "./modules/gmail/gmail-provider-configuration.js";
import { PrismaGmailConnectionRepository } from "./modules/gmail/prisma-gmail-connection-repository.js";
import { createTokenEncryptionProvider } from "./modules/gmail/token-encryption.js";
import { InvitationService } from "./modules/invitations/invitation-service.js";
import { PrismaInvitationRepository } from "./modules/invitations/prisma-invitation-repository.js";
import { PrismaTeamRepository } from "./modules/teams/prisma-team-repository.js";
import { TeamService } from "./modules/teams/team-service.js";
import { PrismaSecurityThrottleRepository } from "./modules/security/prisma-security-throttle-repository.js";
import { SecurityThrottleService } from "./modules/security/security-throttle-service.js";

loadDotenv({
  path: new URL("../../../.env", import.meta.url),
  override: false,
  quiet: true
});

const environment = loadEnvironment();
const database = createDatabaseClient(environment.DATABASE_URL);
const authRepository = new PrismaAuthRepository(database);
const securityThrottleService = new SecurityThrottleService(
  new PrismaSecurityThrottleRepository(database),
  environment.AUTH_TOKEN_PEPPER
);
const emailSender = new SmtpMagicLinkEmailSender({
  host: environment.SMTP_HOST,
  port: environment.SMTP_PORT,
  secure: environment.SMTP_SECURE,
  user: environment.SMTP_USER,
  password: environment.SMTP_PASSWORD,
  from: environment.EMAIL_FROM
});
const authService = new AuthService({
  repository: authRepository,
  emailSender,
  publicOrigin: environment.PUBLIC_ORIGIN,
  tokenPepper: environment.AUTH_TOKEN_PEPPER,
  magicLinkTtlMinutes: environment.MAGIC_LINK_TTL_MINUTES,
  sessionIdleDays: environment.SESSION_IDLE_DAYS,
  sessionAbsoluteDays: environment.SESSION_ABSOLUTE_DAYS,
  maxActiveSessions: environment.MAX_ACTIVE_SESSIONS
});
const googleAuthService = new GoogleAuthService({
  repository: authRepository,
  authService,
  oauthProvider: new GoogleOAuthClient({
    clientId: environment.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: environment.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: environment.GOOGLE_OAUTH_REDIRECT_URI
  }),
  tokenPepper: environment.AUTH_TOKEN_PEPPER,
  stateTtlMinutes: environment.GOOGLE_OAUTH_STATE_TTL_MINUTES
});
const teamService = new TeamService({
  repository: new PrismaTeamRepository(database)
});
const gmailConnectionService = new GmailConnectionService({
  repository: new PrismaGmailConnectionRepository(database),
  oauthProvider: new GoogleGmailOAuthClient({
    clientId: environment.GMAIL_OAUTH_CLIENT_ID,
    clientSecret: environment.GMAIL_OAUTH_CLIENT_SECRET,
    redirectUri: environment.GMAIL_OAUTH_REDIRECT_URI
  }),
  tokenEncryption: createTokenEncryptionProvider({
    provider: environment.GMAIL_TOKEN_ENCRYPTION_PROVIDER,
    localKey: environment.GMAIL_TOKEN_ENCRYPTION_KEY,
    localKeyVersion: environment.GMAIL_TOKEN_ENCRYPTION_KEY_VERSION,
    kmsKeyName: environment.GMAIL_KMS_KEY_NAME
  }),
  tokenPepper: environment.AUTH_TOKEN_PEPPER,
  stateTtlMinutes: environment.GMAIL_OAUTH_STATE_TTL_MINUTES
});
const invitationService = new InvitationService({
  repository: new PrismaInvitationRepository(database),
  teamService,
  publicOrigin: environment.PUBLIC_ORIGIN,
  tokenPepper: environment.AUTH_TOKEN_PEPPER,
  invitationTtlDays: environment.INVITATION_TTL_DAYS,
  joinGrantTtlMinutes: environment.JOIN_GRANT_TTL_MINUTES,
  lineLinkTtlHours: environment.LINE_LINK_TTL_HOURS,
  securityThrottle: securityThrottleService
});
const app = await buildApp({
  environment,
  authService,
  googleAuthService,
  gmailConnectionService,
  teamService,
  invitationService,
  securityThrottleService,
  readinessCheck: async () => {
    await database.$queryRaw`SELECT 1`;
  }
});
app.log.info(
  {
    mailProviders: {
      GOOGLE: getGmailProviderAvailability(environment)
    }
  },
  "Mail OAuth provider configuration status"
);
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
