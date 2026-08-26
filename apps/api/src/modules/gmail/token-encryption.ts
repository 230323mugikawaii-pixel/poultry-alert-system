import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GoogleAuth } from "google-auth-library";

const LOCAL_PROVIDER = "LOCAL_AES_256_GCM";
const KMS_PROVIDER = "GOOGLE_CLOUD_KMS";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface EncryptedToken {
  readonly ciphertext: string;
  readonly provider: string;
  readonly keyVersion: string;
}

export type StoredEncryptedToken = EncryptedToken;

export interface TokenEncryptionProvider {
  encrypt(plaintext: string): Promise<EncryptedToken>;
  decrypt(token: StoredEncryptedToken): Promise<string>;
}

export class LocalAesGcmTokenEncryptionProvider implements TokenEncryptionProvider {
  private readonly key: Buffer;

  public constructor(
    keyBase64: string,
    private readonly keyVersion: string
  ) {
    this.key = Buffer.from(keyBase64, "base64");
    if (this.key.length !== 32 || !keyVersion.trim()) {
      throw new Error("invalid_local_gmail_encryption_configuration");
    }
  }

  public async encrypt(plaintext: string): Promise<EncryptedToken> {
    assertToken(plaintext);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(this.additionalAuthenticatedData());
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final()
    ]);
    const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    return {
      ciphertext: payload.toString("base64url"),
      provider: LOCAL_PROVIDER,
      keyVersion: this.keyVersion
    };
  }

  public async decrypt(token: StoredEncryptedToken): Promise<string> {
    if (
      token.provider !== LOCAL_PROVIDER ||
      token.keyVersion !== this.keyVersion
    ) {
      throw new Error("gmail_encryption_key_unavailable");
    }
    try {
      const payload = Buffer.from(token.ciphertext, "base64url");
      if (payload.length <= IV_BYTES + AUTH_TAG_BYTES) {
        throw new Error("invalid_payload");
      }
      const iv = payload.subarray(0, IV_BYTES);
      const authTag = payload.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
      const encrypted = payload.subarray(IV_BYTES + AUTH_TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAAD(this.additionalAuthenticatedData());
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([
        decipher.update(encrypted),
        decipher.final()
      ]).toString("utf8");
      assertToken(plaintext);
      return plaintext;
    } catch {
      throw new Error("gmail_token_decryption_failed");
    }
  }

  private additionalAuthenticatedData(): Buffer {
    return Buffer.from(`call-now:gmail-refresh-token:${this.keyVersion}`);
  }
}

interface KmsEncryptResponse {
  readonly name?: string;
  readonly ciphertext?: string;
}

interface KmsDecryptResponse {
  readonly plaintext?: string;
}

export class GoogleCloudKmsTokenEncryptionProvider implements TokenEncryptionProvider {
  private readonly auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"]
  });

  public constructor(private readonly cryptoKeyName: string) {
    if (
      !/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(
        cryptoKeyName
      )
    ) {
      throw new Error("invalid_gmail_kms_key_name");
    }
  }

  public async encrypt(plaintext: string): Promise<EncryptedToken> {
    assertToken(plaintext);
    const client = await this.auth.getClient();
    const response = await client.request<KmsEncryptResponse>({
      url: `https://cloudkms.googleapis.com/v1/${this.cryptoKeyName}:encrypt`,
      method: "POST",
      data: { plaintext: Buffer.from(plaintext, "utf8").toString("base64") }
    });
    if (!response.data.ciphertext) {
      throw new Error("gmail_token_encryption_failed");
    }
    return {
      ciphertext: response.data.ciphertext,
      provider: KMS_PROVIDER,
      keyVersion: response.data.name ?? this.cryptoKeyName
    };
  }

  public async decrypt(token: StoredEncryptedToken): Promise<string> {
    if (token.provider !== KMS_PROVIDER) {
      throw new Error("gmail_encryption_provider_mismatch");
    }
    const client = await this.auth.getClient();
    const response = await client.request<KmsDecryptResponse>({
      url: `https://cloudkms.googleapis.com/v1/${this.cryptoKeyName}:decrypt`,
      method: "POST",
      data: { ciphertext: token.ciphertext }
    });
    if (!response.data.plaintext) {
      throw new Error("gmail_token_decryption_failed");
    }
    const plaintext = Buffer.from(response.data.plaintext, "base64").toString(
      "utf8"
    );
    assertToken(plaintext);
    return plaintext;
  }
}

export function createTokenEncryptionProvider(input: {
  readonly provider: "local" | "gcp-kms";
  readonly localKey: string;
  readonly localKeyVersion: string;
  readonly kmsKeyName: string;
}): TokenEncryptionProvider {
  return input.provider === "gcp-kms"
    ? new GoogleCloudKmsTokenEncryptionProvider(input.kmsKeyName)
    : new LocalAesGcmTokenEncryptionProvider(
        input.localKey,
        input.localKeyVersion
      );
}

function assertToken(value: string): void {
  if (!value || value.length > 16_384 || /[\r\n\0]/u.test(value)) {
    throw new Error("invalid_gmail_refresh_token");
  }
}
