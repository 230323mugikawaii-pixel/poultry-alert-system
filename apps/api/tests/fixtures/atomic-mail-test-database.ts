import type { DatabaseClient } from "../../src/db/client.js";
import type { Prisma } from "../../src/generated/prisma/client.js";

// Test-only interception of the OUTER transaction; production has no crash hooks.
export function atomicTestDatabase(
  database: DatabaseClient,
  hooks: {
    enter?: () => void;
    leave?: () => void;
    beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void>;
    afterCommit?: () => Promise<void>;
  }
): DatabaseClient {
  return new Proxy(database, {
    get(target, key, receiver) {
      if (key !== "$transaction")
        return Reflect.get(target, key, receiver) as unknown;
      return async (
        body: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options: Parameters<DatabaseClient["$transaction"]>[1]
      ) => {
        let atomic = false;
        hooks.enter?.();
        let result: unknown;
        try {
          result = await target.$transaction(
            async (tx) => {
              const value = await body(tx);
              atomic =
                !!value &&
                typeof value === "object" &&
                "alert" in value &&
                "created" in value;
              if (atomic) await hooks.beforeCommit?.(tx);
              return value;
            },
            { ...options, timeout: 60_000 }
          );
        } finally {
          hooks.leave?.();
        }
        if (atomic) await hooks.afterCommit?.();
        return result;
      };
    }
  });
}
