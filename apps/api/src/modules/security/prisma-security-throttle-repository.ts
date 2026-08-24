import { Prisma } from "../../generated/prisma/client.js";
import type { DatabaseClient } from "../../db/client.js";
import type {
  IncrementSecurityThrottleInput,
  SecurityThrottleRecord,
  SecurityThrottleRepository
} from "./security-throttle-repository.js";

interface ThrottleRow {
  readonly failureCount: number;
  readonly lockedUntil: Date | null;
}

export class PrismaSecurityThrottleRepository implements SecurityThrottleRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async find(keyHash: string): Promise<SecurityThrottleRecord | null> {
    const throttle = await this.database.securityThrottle.findUnique({
      where: { keyHash },
      select: { failureCount: true, lockedUntil: true }
    });
    return throttle
      ? {
          attemptCount: throttle.failureCount,
          lockedUntil: throttle.lockedUntil
        }
      : null;
  }

  public async increment(
    input: IncrementSecurityThrottleInput
  ): Promise<SecurityThrottleRecord> {
    const nextCount = Prisma.sql`
      CASE
        WHEN "security_throttles"."lockedUntil" IS NOT NULL
          AND "security_throttles"."lockedUntil" > ${input.now}
          THEN "security_throttles"."failureCount"
        WHEN "security_throttles"."windowStartedAt"
          + (${input.windowMinutes} * INTERVAL '1 minute') <= ${input.now}
          THEN 1
        ELSE "security_throttles"."failureCount" + 1
      END
    `;
    const rows = await this.database.$queryRaw<ThrottleRow[]>(Prisma.sql`
      INSERT INTO "security_throttles" (
        "keyHash",
        "scope",
        "failureCount",
        "windowStartedAt",
        "lockedUntil",
        "updatedAt"
      )
      VALUES (
        ${input.keyHash},
        ${input.scope},
        1,
        ${input.now},
        ${input.lockAtCount <= 1 ? addMinutes(input.now, input.lockMinutes) : null},
        ${input.now}
      )
      ON CONFLICT ("keyHash") DO UPDATE SET
        "scope" = EXCLUDED."scope",
        "failureCount" = ${nextCount},
        "windowStartedAt" = CASE
          WHEN "security_throttles"."lockedUntil" IS NOT NULL
            AND "security_throttles"."lockedUntil" > ${input.now}
            THEN "security_throttles"."windowStartedAt"
          WHEN "security_throttles"."windowStartedAt"
            + (${input.windowMinutes} * INTERVAL '1 minute') <= ${input.now}
            THEN ${input.now}
          ELSE "security_throttles"."windowStartedAt"
        END,
        "lockedUntil" = CASE
          WHEN "security_throttles"."lockedUntil" IS NOT NULL
            AND "security_throttles"."lockedUntil" > ${input.now}
            THEN "security_throttles"."lockedUntil"
          WHEN (${nextCount}) >= ${input.lockAtCount}
            THEN ${addMinutes(input.now, input.lockMinutes)}
          ELSE NULL
        END,
        "updatedAt" = ${input.now}
      RETURNING
        "failureCount",
        "lockedUntil"
    `);
    const row = rows[0];
    if (!row) {
      throw new Error("security_throttle_increment_failed");
    }
    return {
      attemptCount: row.failureCount,
      lockedUntil: row.lockedUntil
    };
  }

  public async clear(keyHashes: readonly string[]): Promise<void> {
    if (keyHashes.length === 0) return;
    await this.database.securityThrottle.deleteMany({
      where: { keyHash: { in: [...keyHashes] } }
    });
  }
}

function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * 60_000);
}
