import type { AppEnvironment } from "../../config/env.js";

export type GmailProviderAvailability = "AVAILABLE" | "NOT_CONFIGURED";

const PLACEHOLDER_PATTERN =
  /^(?:development-|replace-with-|placeholder|changeme|change-me)/iu;

export function getGmailProviderAvailability(
  environment: Pick<
    AppEnvironment,
    | "GMAIL_OAUTH_CLIENT_ID"
    | "GMAIL_OAUTH_CLIENT_SECRET"
    | "GMAIL_OAUTH_REDIRECT_URI"
    | "GMAIL_TOKEN_ENCRYPTION_PROVIDER"
    | "GMAIL_TOKEN_ENCRYPTION_KEY"
    | "GMAIL_KMS_KEY_NAME"
  >
): GmailProviderAvailability {
  if (
    !isConfiguredValue(environment.GMAIL_OAUTH_CLIENT_ID) ||
    !isConfiguredValue(environment.GMAIL_OAUTH_CLIENT_SECRET) ||
    !isValidUrl(environment.GMAIL_OAUTH_REDIRECT_URI) ||
    !hasUsableEncryptionConfiguration(environment)
  ) {
    return "NOT_CONFIGURED";
  }

  return "AVAILABLE";
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
    | "GMAIL_TOKEN_ENCRYPTION_PROVIDER"
    | "GMAIL_TOKEN_ENCRYPTION_KEY"
    | "GMAIL_KMS_KEY_NAME"
  >
): boolean {
  if (environment.GMAIL_TOKEN_ENCRYPTION_PROVIDER === "gcp-kms") {
    return /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/u.test(
      environment.GMAIL_KMS_KEY_NAME
    );
  }

  try {
    const key = Buffer.from(environment.GMAIL_TOKEN_ENCRYPTION_KEY, "base64");
    return key.length === 32 && key.some((byte) => byte !== 0);
  } catch {
    return false;
  }
}
