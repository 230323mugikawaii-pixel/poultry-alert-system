import { createHmac } from "node:crypto";
import { AppError } from "../../lib/app-error.js";
import type { SecurityThrottleRepository } from "./security-throttle-repository.js";

export interface SecurityThrottleRule {
  readonly scope: string;
  readonly dimensions: readonly string[];
  readonly maximumAttempts: number;
  readonly windowMinutes: number;
  readonly lockMinutes: number;
}

export interface SecurityThrottleError {
  readonly code: string;
  readonly message: string;
  readonly statusCode?: number;
}

export class SecurityThrottleService {
  private readonly now: () => Date;

  public constructor(
    private readonly repository: SecurityThrottleRepository,
    private readonly pepper: string,
    now?: () => Date
  ) {
    this.now = now ?? (() => new Date());
  }

  public async consume(
    rules: readonly SecurityThrottleRule[],
    error: SecurityThrottleError = defaultRateLimitError()
  ): Promise<void> {
    for (const rule of rules) {
      assertRule(rule);
      const now = this.now();
      const throttle = await this.repository.increment({
        keyHash: this.keyHash(rule),
        scope: rule.scope,
        now,
        windowMinutes: rule.windowMinutes,
        lockAtCount: rule.maximumAttempts + 1,
        lockMinutes: rule.lockMinutes
      });
      if (throttle.lockedUntil && throttle.lockedUntil > now) {
        throw toAppError(error);
      }
    }
  }

  public async assertFailuresAllowed(
    rules: readonly SecurityThrottleRule[],
    error: SecurityThrottleError
  ): Promise<void> {
    const now = this.now();
    for (const rule of rules) {
      assertRule(rule);
      const throttle = await this.repository.find(this.keyHash(rule));
      if (throttle?.lockedUntil && throttle.lockedUntil > now) {
        throw toAppError(error);
      }
    }
  }

  public async recordFailure(
    rules: readonly SecurityThrottleRule[]
  ): Promise<void> {
    for (const rule of rules) {
      assertRule(rule);
      const now = this.now();
      await this.repository.increment({
        keyHash: this.keyHash(rule),
        scope: rule.scope,
        now,
        windowMinutes: rule.windowMinutes,
        lockAtCount: rule.maximumAttempts,
        lockMinutes: rule.lockMinutes
      });
    }
  }

  public async clear(rules: readonly SecurityThrottleRule[]): Promise<void> {
    await this.repository.clear(rules.map((rule) => this.keyHash(rule)));
  }

  private keyHash(rule: SecurityThrottleRule): string {
    const hmac = createHmac("sha256", this.pepper);
    hmac.update(rule.scope, "utf8");
    for (const dimension of rule.dimensions) {
      hmac.update("\0", "utf8");
      hmac.update(String(Buffer.byteLength(dimension, "utf8")), "utf8");
      hmac.update(":", "utf8");
      hmac.update(dimension, "utf8");
    }
    return hmac.digest("hex");
  }
}

function assertRule(rule: SecurityThrottleRule): void {
  if (
    !rule.scope ||
    rule.scope.length > 50 ||
    rule.maximumAttempts < 1 ||
    rule.windowMinutes < 1 ||
    rule.lockMinutes < 1
  ) {
    throw new Error("invalid_security_throttle_rule");
  }
}

function defaultRateLimitError(): SecurityThrottleError {
  return {
    code: "SECURITY_RATE_LIMITED",
    message: "試行回数が上限に達しました。しばらく待ってからお試しください。",
    statusCode: 429
  };
}

function toAppError(error: SecurityThrottleError): AppError {
  return new AppError(error.code, error.message, error.statusCode ?? 429);
}
