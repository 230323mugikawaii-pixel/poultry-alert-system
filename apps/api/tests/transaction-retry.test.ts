import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/lib/app-error.js";
import {
  isRetryableTransactionError,
  retrySerializableTransaction
} from "../src/db/transaction-retry.js";

const noWait = async () => undefined;

describe("serializable transaction retry", () => {
  it("retries Prisma and PostgreSQL serialization failures", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ code: "P2034" })
      .mockRejectedValueOnce({ cause: { originalCode: "40001" } })
      .mockResolvedValue("joined");

    await expect(
      retrySerializableTransaction(operation, conflictError, {
        wait: noWait
      })
    ).resolves.toBe("joined");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(isRetryableTransactionError({ code: "40P01" })).toBe(true);
  });

  it("returns a stable 409 after repeated transaction conflicts", async () => {
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue({
      meta: { driverAdapterError: { cause: { code: "40001" } } }
    });

    await expect(
      retrySerializableTransaction(operation, conflictError, {
        maximumAttempts: 3,
        wait: noWait
      })
    ).rejects.toMatchObject({
      code: "JOIN_TRANSACTION_CONFLICT",
      statusCode: 409
    });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry application or validation errors", async () => {
    const applicationError = new AppError("INVITATION_EXHAUSTED", "full", 409);
    const operation = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(applicationError);

    await expect(
      retrySerializableTransaction(operation, conflictError, {
        wait: noWait
      })
    ).rejects.toBe(applicationError);
    expect(operation).toHaveBeenCalledOnce();
  });
});

function conflictError(): AppError {
  return new AppError(
    "JOIN_TRANSACTION_CONFLICT",
    "参加処理が競合しました。もう一度お試しください。",
    409
  );
}
