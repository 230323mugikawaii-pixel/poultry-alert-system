import { SignJWT } from "jose";
import type { ApnsConfiguration } from "./apns-config.js";

export class ApnsProviderToken {
  private cached: { value: string; issuedAt: number } | undefined;
  private pending: Promise<string> | undefined;
  public constructor(
    private readonly configuration: ApnsConfiguration,
    private readonly now: () => number = Date.now
  ) {}

  public async get(): Promise<string> {
    const seconds = Math.floor(this.now() / 1000);
    if (!Number.isSafeInteger(seconds) || seconds < 0)
      throw new Error("APNS_CLOCK_INVALID");
    if (this.cached) {
      const age = seconds - this.cached.issuedAt;
      if (age < 0) throw new Error("APNS_CLOCK_INVALID");
      if (age < 50 * 60) return this.cached.value;
    }
    if (this.pending) return this.pending;
    this.pending = new SignJWT({ iss: this.configuration.teamId, iat: seconds })
      .setProtectedHeader({ alg: "ES256", kid: this.configuration.keyId })
      .sign(this.configuration.privateKey)
      .then((value) => {
        this.cached = { value, issuedAt: seconds };
        return value;
      })
      .catch(() => {
        throw new Error("APNS_SIGNING_FAILED");
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  public async expired(rejectedToken: string): Promise<boolean> {
    if (this.pending) await this.pending;
    // A late response to the previous JWT cannot invalidate a newly rotated JWT.
    if (this.cached && this.cached.value !== rejectedToken) return true;
    if (!this.cached || this.now() / 1000 - this.cached.issuedAt < 20 * 60)
      return false;
    this.cached = undefined;
    await this.get();
    return true;
  }
}
