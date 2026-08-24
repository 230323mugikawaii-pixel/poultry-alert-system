export interface SecurityThrottleRecord {
  readonly attemptCount: number;
  readonly lockedUntil: Date | null;
}

export interface IncrementSecurityThrottleInput {
  readonly keyHash: string;
  readonly scope: string;
  readonly now: Date;
  readonly windowMinutes: number;
  readonly lockAtCount: number;
  readonly lockMinutes: number;
}

export interface SecurityThrottleRepository {
  find(keyHash: string): Promise<SecurityThrottleRecord | null>;
  increment(
    input: IncrementSecurityThrottleInput
  ): Promise<SecurityThrottleRecord>;
  clear(keyHashes: readonly string[]): Promise<void>;
}
