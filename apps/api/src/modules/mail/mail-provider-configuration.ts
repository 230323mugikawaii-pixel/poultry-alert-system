import type { AppEnvironment } from "../../config/env.js";
import type { MailProviderId } from "./mail-provider.js";

export type MailProviderAvailability = "AVAILABLE" | "NOT_CONFIGURED";

const PLACEHOLDER_PATTERN =
  /^(?:development-|replace-with-|placeholder|changeme|change-me)/iu;

type MailConfigurationEnvironment = Pick<
  AppEnvironment,
  | "APP_ENV"
  | "GMAIL_OAUTH_CLIENT_ID"
  | "GMAIL_OAUTH_CLIENT_SECRET"
  | "GMAIL_OAUTH_REDIRECT_URI"
  | "MICROSOFT_OAUTH_CLIENT_ID"
  | "MICROSOFT_OAUTH_CLIENT_SECRET"
  | "MICROSOFT_OAUTH_REDIRECT_URI"
  | "MICROSOFT_OAUTH_TENANT"
  | "MAIL_TOKEN_ENCRYPTION_PROVIDER"
  | "MAIL_TOKEN_ENCRYPTION_KEY"
  | "MAIL_KMS_KEY_NAME"
  | "GMAIL_PUSH_MONITORING_ENABLED"
  | "GMAIL_PUBSUB_TOPIC_NAME"
  | "GMAIL_PUBSUB_PUSH_AUDIENCE"
  | "GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL"
>;

export function getMailProviderAvailability(
  environment: MailConfigurationEnvironment,
  provider: MailProviderId
): MailProviderAvailability {
  const providerConfigured =
    provider === "GOOGLE"
      ? isConfiguredValue(environment.GMAIL_OAUTH_CLIENT_ID) &&
        isConfiguredValue(environment.GMAIL_OAUTH_CLIENT_SECRET) &&
        isValidUrl(environment.GMAIL_OAUTH_REDIRECT_URI)
      : isConfiguredValue(environment.MICROSOFT_OAUTH_CLIENT_ID) &&
        isConfiguredValue(environment.MICROSOFT_OAUTH_CLIENT_SECRET) &&
        isConfiguredValue(environment.MICROSOFT_OAUTH_TENANT) &&
        isValidUrl(environment.MICROSOFT_OAUTH_REDIRECT_URI);

  const pushMonitoringReady =
    provider !== "GOOGLE" ||
    environment.APP_ENV === "development" ||
    environment.APP_ENV === "test" ||
    (environment.GMAIL_PUSH_MONITORING_ENABLED &&
      /^projects\/[^/]+\/topics\/[^/]+$/u.test(
        environment.GMAIL_PUBSUB_TOPIC_NAME
      ) &&
      isValidUrl(environment.GMAIL_PUBSUB_PUSH_AUDIENCE) &&
      /^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/u.test(
        environment.GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL
      ));

  return providerConfigured &&
    hasUsableEncryptionConfiguration(environment) &&
    pushMonitoringReady
    ? "AVAILABLE"
    : "NOT_CONFIGURED";
}

export function getMailProviderStatuses(
  environment: MailConfigurationEnvironment
): Readonly<Record<MailProviderId, MailProviderAvailability>> {
  return {
    GOOGLE: getMailProviderAvailability(environment, "GOOGLE"),
    MICROSOFT: getMailProviderAvailability(environment, "MICROSOFT")
  };
}

function isConfiguredValue(value: string): boolean {
  const normalized = value.trim();
  return Boolean(normalized) && !PLACEHOLDER_PATTERN.test(normalized);
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function hasUsableEncryptionConfiguration(
  environment: Pick<
    AppEnvironment,
    | "MAIL_TOKEN_ENCRYPTION_PROVIDER"
    | "MAIL_TOKEN_ENCRYPTION_KEY"
    | "MAIL_KMS_KEY_NAME"
  >
): boolean {
  if (environment.MAIL_TOKEN_ENCRYPTION_PROVIDER === "gcp-kms") {
    return /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/u.test(
      environment.MAIL_KMS_KEY_NAME
    );
  }

  try {
    const key = Buffer.from(environment.MAIL_TOKEN_ENCRYPTION_KEY, "base64");
    return key.length === 32 && key.some((byte) => byte !== 0);
  } catch {
    return false;
  }
}
