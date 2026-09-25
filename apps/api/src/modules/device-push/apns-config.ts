import { createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

export interface ApnsConfiguration {
  readonly environment: "sandbox" | "production";
  readonly teamId: string;
  readonly keyId: string;
  readonly topic: string;
  readonly privateKey: KeyObject;
  readonly expirationSeconds: number;
}

// Read only for an explicitly opted-in CLI. Never load .env or accept an endpoint override.
export function readApnsConfiguration(
  env: NodeJS.ProcessEnv
): ApnsConfiguration {
  try {
    if (env.APP_ENV === "production") throw new Error();
    const environment = env.APNS_ENVIRONMENT;
    if (environment !== "sandbox" && environment !== "production")
      throw new Error();
    const teamId = env.APNS_TEAM_ID ?? "",
      keyId = env.APNS_KEY_ID ?? "";
    const topic = env.APNS_BUNDLE_ID ?? "";
    if (
      !/^[A-Z0-9]{10}$/u.test(teamId) ||
      !/^[A-Z0-9]{10}$/u.test(keyId) ||
      topic.length > 255 ||
      !/^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/u.test(topic)
    )
      throw new Error();
    const path = env.APNS_PRIVATE_KEY_FILE,
      inline = env.APNS_PRIVATE_KEY;
    if (Boolean(path) === Boolean(inline)) throw new Error();
    const pem = path
      ? readFileSync(path, "utf8")
      : inline!.replaceAll("\\n", "\n");
    if (
      pem.length > 16_384 ||
      !/^\s*-----BEGIN PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]+-----END PRIVATE KEY-----\s*$/u.test(
        pem
      )
    )
      throw new Error();
    const privateKey = createPrivateKey({
      key: pem,
      format: "pem",
      type: "pkcs8"
    });
    if (
      privateKey.asymmetricKeyType !== "ec" ||
      privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    )
      throw new Error();
    const rawExpiration = env.APNS_EXPIRATION_SECONDS ?? "86400";
    if (!/^\d+$/u.test(rawExpiration)) throw new Error();
    const expirationSeconds = Number(rawExpiration);
    if (
      !Number.isSafeInteger(expirationSeconds) ||
      expirationSeconds < 1 ||
      expirationSeconds > 604800
    )
      throw new Error();
    return { environment, teamId, keyId, topic, privateKey, expirationSeconds };
  } catch {
    // Includes filesystem/crypto errors: no filenames, key material, nested cause or URLs.
    throw new Error("APNS_CONFIGURATION_INVALID");
  }
}

export function apnsPlannerConfiguration(
  env: NodeJS.ProcessEnv
): "missing" | "validated" {
  if (env.APP_ENV === "production")
    throw new Error("APNS_PRODUCTION_FORBIDDEN");
  try {
    readApnsConfiguration(env);
    return "validated";
  } catch {
    return "missing";
  }
}
