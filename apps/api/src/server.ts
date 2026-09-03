import { config as loadDotenv } from "dotenv";
import { buildApp } from "./app.js";
import { loadEnvironment } from "./config/env.js";
import { createDatabaseClient } from "./db/client.js";
import { AlertService } from "./modules/alerts/alert-service.js";
import { PrismaAlertRepository } from "./modules/alerts/prisma-alert-repository.js";
import { NotificationTestService } from "./modules/alerts/notification-test-service.js";
import { PrismaNotificationTestRepository } from "./modules/alerts/prisma-notification-test-repository.js";
import { AppleLoginOAuthClient } from "./modules/auth/apple-login-oauth-client.js";
import { AuthService } from "./modules/auth/auth-service.js";
import { SmtpMagicLinkEmailSender } from "./modules/auth/email-sender.js";
import { GoogleOAuthClient } from "./modules/auth/google-oauth-client.js";
import { MicrosoftLoginOAuthClient } from "./modules/auth/microsoft-login-oauth-client.js";
import type { PrimaryAuthProviderAdapter } from "./modules/auth/primary-auth-provider.js";
import { PrimaryAuthService } from "./modules/auth/primary-auth-service.js";
import { PrismaAuthRepository } from "./modules/auth/prisma-auth-repository.js";
import { MailConnectionService } from "./modules/mail/mail-connection-service.js";
import { GoogleGmailApiClient } from "./modules/mail/gmail/gmail-api-client.js";
import {
  GmailMonitoringService,
  type GmailMonitoringLogger
} from "./modules/mail/gmail/gmail-monitoring-service.js";
import { GooglePubSubPushAuthenticator } from "./modules/mail/gmail/gmail-pubsub-authenticator.js";
import { PrismaGmailMonitoringRepository } from "./modules/mail/gmail/prisma-gmail-monitoring-repository.js";
import {
  getMailProviderAvailability,
  getMailProviderStatuses
} from "./modules/mail/mail-provider-configuration.js";
import type { MailProviderAdapter } from "./modules/mail/mail-provider.js";
import { PrismaMailConnectionRepository } from "./modules/mail/prisma-mail-connection-repository.js";
import { GoogleMailProvider } from "./modules/mail/providers/google-mail-provider.js";
import { MicrosoftMailProvider } from "./modules/mail/providers/microsoft-mail-provider.js";
import { createTokenEncryptionProvider } from "./modules/mail/token-encryption.js";
import { InvitationService } from "./modules/invitations/invitation-service.js";
import { NotificationMemberService } from "./modules/notification-members/notification-member-service.js";
import { PrismaNotificationMemberRepository } from "./modules/notification-members/prisma-notification-member-repository.js";
import { PrismaInvitationRepository } from "./modules/invitations/prisma-invitation-repository.js";
import { PrismaTeamRepository } from "./modules/teams/prisma-team-repository.js";
import { DEFAULT_MAX_CONFIGURED_SEAT_COUNT } from "./modules/teams/seat-policy.js";
import { TeamService } from "./modules/teams/team-service.js";
import { PrismaSecurityThrottleRepository } from "./modules/security/prisma-security-throttle-repository.js";
import { SecurityThrottleService } from "./modules/security/security-throttle-service.js";
import { OwnerOnboardingService } from "./modules/onboarding/owner-onboarding-service.js";
import { PrismaOwnerOnboardingRepository } from "./modules/onboarding/prisma-owner-onboarding-repository.js";
import { PrismaUserCommunicationRepository } from "./modules/user-communications/prisma-user-communication-repository.js";
import { UserCommunicationService } from "./modules/user-communications/user-communication-service.js";

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
const primaryAuthProviders: PrimaryAuthProviderAdapter[] = [
  new GoogleOAuthClient({
    clientId: environment.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: environment.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: environment.GOOGLE_OAUTH_REDIRECT_URI
  })
];
if (
  environment.MICROSOFT_LOGIN_OAUTH_CLIENT_ID &&
  environment.MICROSOFT_LOGIN_OAUTH_CLIENT_SECRET &&
  environment.MICROSOFT_LOGIN_OAUTH_REDIRECT_URI
) {
  primaryAuthProviders.push(
    new MicrosoftLoginOAuthClient({
      clientId: environment.MICROSOFT_LOGIN_OAUTH_CLIENT_ID,
      clientSecret: environment.MICROSOFT_LOGIN_OAUTH_CLIENT_SECRET,
      redirectUri: environment.MICROSOFT_LOGIN_OAUTH_REDIRECT_URI,
      tenant: environment.MICROSOFT_LOGIN_OAUTH_TENANT
    })
  );
}
if (
  environment.APPLE_OAUTH_CLIENT_ID &&
  environment.APPLE_OAUTH_TEAM_ID &&
  environment.APPLE_OAUTH_KEY_ID &&
  environment.APPLE_OAUTH_PRIVATE_KEY &&
  environment.APPLE_OAUTH_REDIRECT_URI
) {
  primaryAuthProviders.push(
    new AppleLoginOAuthClient({
      clientId: environment.APPLE_OAUTH_CLIENT_ID,
      teamId: environment.APPLE_OAUTH_TEAM_ID,
      keyId: environment.APPLE_OAUTH_KEY_ID,
      privateKey: environment.APPLE_OAUTH_PRIVATE_KEY,
      redirectUri: environment.APPLE_OAUTH_REDIRECT_URI
    })
  );
}
const primaryAuthService = new PrimaryAuthService({
  repository: authRepository,
  authService,
  providerAdapters: primaryAuthProviders,
  tokenPepper: environment.AUTH_TOKEN_PEPPER,
  stateTtlMinutes: {
    GOOGLE: environment.GOOGLE_OAUTH_STATE_TTL_MINUTES,
    MICROSOFT: environment.MICROSOFT_LOGIN_OAUTH_STATE_TTL_MINUTES,
    APPLE: environment.APPLE_OAUTH_STATE_TTL_MINUTES
  }
});
const teamService = new TeamService({
  repository: new PrismaTeamRepository(database),
  maxConfiguredSeatCount:
    environment.MAX_CONFIGURED_SEAT_COUNT ?? DEFAULT_MAX_CONFIGURED_SEAT_COUNT
});
const googleMailProvider = new GoogleMailProvider({
  clientId: environment.GMAIL_OAUTH_CLIENT_ID,
  clientSecret: environment.GMAIL_OAUTH_CLIENT_SECRET,
  redirectUri: environment.GMAIL_OAUTH_REDIRECT_URI
});
const mailProviderAdapters: MailProviderAdapter[] = [
  googleMailProvider,
  new MicrosoftMailProvider({
    clientId: environment.MICROSOFT_OAUTH_CLIENT_ID,
    clientSecret: environment.MICROSOFT_OAUTH_CLIENT_SECRET,
    redirectUri: environment.MICROSOFT_OAUTH_REDIRECT_URI,
    tenant: environment.MICROSOFT_OAUTH_TENANT
  })
];
const tokenEncryption = createTokenEncryptionProvider({
  provider: environment.MAIL_TOKEN_ENCRYPTION_PROVIDER,
  localKey: environment.MAIL_TOKEN_ENCRYPTION_KEY,
  localKeyVersion: environment.MAIL_TOKEN_ENCRYPTION_KEY_VERSION,
  kmsKeyName: environment.MAIL_KMS_KEY_NAME
});
const mailConnectionService = new MailConnectionService({
  repository: new PrismaMailConnectionRepository(database),
  providerAdapters: mailProviderAdapters,
  tokenEncryption,
  tokenPepper: environment.AUTH_TOKEN_PEPPER,
  stateTtlMinutes: {
    GOOGLE: environment.GMAIL_OAUTH_STATE_TTL_MINUTES,
    MICROSOFT: environment.MICROSOFT_OAUTH_STATE_TTL_MINUTES
  }
});
const ownerOnboardingService = new OwnerOnboardingService({
  repository: new PrismaOwnerOnboardingRepository(database),
  authRepository,
  authService,
  teamService,
  providerAdapters: mailProviderAdapters.filter(
    (provider) =>
      getMailProviderAvailability(environment, provider.provider) ===
      "AVAILABLE"
  ),
  tokenEncryption,
  tokenPepper: environment.AUTH_TOKEN_PEPPER,
  stateTtlMinutes: {
    GOOGLE: environment.GMAIL_OAUTH_STATE_TTL_MINUTES,
    MICROSOFT: environment.MICROSOFT_OAUTH_STATE_TTL_MINUTES
  },
  onboardingTtlHours: environment.OWNER_ONBOARDING_TTL_HOURS ?? 168
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
const notificationMemberService = new NotificationMemberService({
  repository: new PrismaNotificationMemberRepository(database),
  securityThrottle: securityThrottleService,
  tokenPepper: environment.AUTH_TOKEN_PEPPER,
  sessionIdleDays: environment.SESSION_IDLE_DAYS,
  sessionAbsoluteDays: environment.SESSION_ABSOLUTE_DAYS,
  maxActiveSessions: environment.MAX_ACTIVE_SESSIONS
});
const alertService = new AlertService({
  repository: new PrismaAlertRepository(database)
});
const notificationTestService = new NotificationTestService({
  repository: new PrismaNotificationTestRepository(database),
  alertService
});
const appLoggerReference: {
  current?: {
    info(data: object, message: string): unknown;
    warn(data: object, message: string): unknown;
  };
} = {};
const gmailMonitoringLogger: GmailMonitoringLogger = {
  info: (event, metadata) =>
    appLoggerReference.current?.info(
      { event, ...metadata },
      "Gmail monitoring event"
    ),
  warn: (event, metadata) =>
    appLoggerReference.current?.warn(
      { event, ...metadata },
      "Gmail monitoring warning"
    )
};
const gmailMonitoringService = environment.GMAIL_PUSH_MONITORING_ENABLED
  ? new GmailMonitoringService({
      repository: new PrismaGmailMonitoringRepository(database),
      api: new GoogleGmailApiClient(),
      googleProvider: googleMailProvider,
      tokenEncryption,
      alertService,
      topicName: environment.GMAIL_PUBSUB_TOPIC_NAME,
      renewBeforeHours: environment.GMAIL_WATCH_RENEW_BEFORE_HOURS,
      historyRecoveryLookbackHours:
        environment.GMAIL_HISTORY_RECOVERY_LOOKBACK_HOURS,
      logger: gmailMonitoringLogger
    })
  : undefined;
const gmailPubSubAuthenticator = environment.GMAIL_PUSH_MONITORING_ENABLED
  ? new GooglePubSubPushAuthenticator({
      audience: environment.GMAIL_PUBSUB_PUSH_AUDIENCE,
      serviceAccountEmail: environment.GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL
    })
  : undefined;
const userCommunicationService = new UserCommunicationService(
  new PrismaUserCommunicationRepository(database)
);
const app = await buildApp({
  environment,
  authService,
  primaryAuthService,
  mailConnectionService,
  ...(gmailMonitoringService && gmailPubSubAuthenticator
    ? { gmailMonitoringService, gmailPubSubAuthenticator }
    : {}),
  teamService,
  invitationService,
  notificationMemberService,
  alertService,
  notificationTestService,
  userCommunicationService,
  ownerOnboardingService,
  securityThrottleService,
  readinessCheck: async () => {
    await database.$queryRaw`SELECT 1`;
  }
});
appLoggerReference.current = app.log;
app.log.info(
  { mailProviders: getMailProviderStatuses(environment) },
  "Mail OAuth provider configuration status"
);
app.log.info(
  {
    loginProviders: {
      GOOGLE: primaryAuthService.getProviderAvailability("GOOGLE"),
      MICROSOFT: primaryAuthService.getProviderAvailability("MICROSOFT"),
      APPLE: primaryAuthService.getProviderAvailability("APPLE")
    }
  },
  "Primary login provider configuration status"
);
app.addHook("onClose", async () => database.$disconnect());
const onboardingCleanupTimer = setInterval(
  () => {
    void ownerOnboardingService.cleanupExpired().catch((error: unknown) => {
      app.log.warn(
        { code: error instanceof Error ? error.name : "UNKNOWN" },
        "Owner onboarding cleanup failed"
      );
    });
  },
  60 * 60 * 1000
);
onboardingCleanupTimer.unref();
app.addHook("onClose", async () => clearInterval(onboardingCleanupTimer));
const notificationTestCleanupTimer = setInterval(() => {
  void notificationTestService.cleanupExpired().catch((error: unknown) => {
    app.log.warn(
      { code: error instanceof Error ? error.name : "UNKNOWN" },
      "Notification test cleanup failed"
    );
  });
}, 60 * 1_000);
notificationTestCleanupTimer.unref();
app.addHook("onClose", async () => clearInterval(notificationTestCleanupTimer));

let gmailWatchRenewalTimer: NodeJS.Timeout | undefined;
if (gmailMonitoringService) {
  const renewGmailWatches = (): void => {
    void gmailMonitoringService
      .renewEligibleWatches()
      .then((result) => {
        app.log.info(
          { event: "gmail_watch_reconciliation_completed", ...result },
          "Gmail watch reconciliation completed"
        );
      })
      .catch(() => {
        app.log.warn(
          { event: "gmail_watch_reconciliation_failed" },
          "Gmail watch reconciliation failed"
        );
      });
  };
  gmailWatchRenewalTimer = setInterval(renewGmailWatches, 60 * 1_000);
  gmailWatchRenewalTimer.unref();
  setImmediate(renewGmailWatches);
}
app.addHook("onClose", async () => {
  if (gmailWatchRenewalTimer) clearInterval(gmailWatchRenewalTimer);
});

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
