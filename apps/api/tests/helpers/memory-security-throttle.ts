import type {
  IncrementSecurityThrottleInput,
  SecurityThrottleRecord,
  SecurityThrottleRepository
} from "../../src/modules/security/security-throttle-repository.js";

export class MemorySecurityThrottleRepository implements SecurityThrottleRepository {
  private readonly records = new Map<
    string,
    SecurityThrottleRecord & { readonly windowStartedAt: Date }
  >();

  public async find(keyHash: string): Promise<SecurityThrottleRecord | null> {
    return this.records.get(keyHash) ?? null;
  }

  public async increment(
    input: IncrementSecurityThrottleInput
  ): Promise<SecurityThrottleRecord> {
    const current = this.records.get(input.keyHash);
    if (current?.lockedUntil && current.lockedUntil > input.now) {
      return current;
    }
    const windowExpired =
      !current ||
      current.windowStartedAt.getTime() + input.windowMinutes * 60_000 <=
        input.now.getTime();
    const attemptCount = windowExpired ? 1 : current.attemptCount + 1;
    const lockedUntil =
      attemptCount >= input.lockAtCount
        ? new Date(input.now.getTime() + input.lockMinutes * 60_000)
        : null;
    const next = {
      attemptCount,
      lockedUntil,
      windowStartedAt: windowExpired
        ? input.now
        : (current?.windowStartedAt ?? input.now)
    };
    this.records.set(input.keyHash, next);
    return next;
  }

  public async clear(keyHashes: readonly string[]): Promise<void> {
    for (const keyHash of keyHashes) this.records.delete(keyHash);
  }
}
