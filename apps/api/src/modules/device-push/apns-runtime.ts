import { createTokenEncryptionProvider } from "../mail/token-encryption.js";
import { readApnsConfiguration } from "./apns-config.js";
import { ApnsHttp2Transport } from "./apns-http2-transport.js";

// CLI-only factory. It cannot inject any address/connector/TLS override.
export function createConfiguredApnsTransport(env: NodeJS.ProcessEnv) {
  const configuration = readApnsConfiguration(env);
  try {
    const provider = env.MAIL_TOKEN_ENCRYPTION_PROVIDER;
    if (provider !== "local" && provider !== "gcp-kms") throw new Error();
    const encryption = createTokenEncryptionProvider({
      provider,
      localKey: env.MAIL_TOKEN_ENCRYPTION_KEY ?? "",
      localKeyVersion: env.MAIL_TOKEN_ENCRYPTION_KEY_VERSION ?? "",
      kmsKeyName: env.MAIL_KMS_KEY_NAME ?? ""
    });
    return {
      environment: configuration.environment,
      transport: ApnsHttp2Transport.create(configuration, encryption)
    };
  } catch {
    throw new Error("APNS_ENCRYPTION_CONFIGURATION_INVALID");
  }
}
