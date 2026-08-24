const RETRYABLE_TRANSACTION_CODES = new Set(["P2034", "40001", "40P01"]);

export interface TransactionRetryOptions {
  readonly maximumAttempts?: number;
  readonly wait?: (attempt: number) => Promise<void>;
}

export async function retrySerializableTransaction<T>(
  operation: () => Promise<T>,
  conflictError: () => Error,
  options: TransactionRetryOptions = {}
): Promise<T> {
  const maximumAttempts = options.maximumAttempts ?? 5;
  const wait = options.wait ?? waitBeforeRetry;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableTransactionError(error)) {
        throw error;
      }
      if (attempt === maximumAttempts) {
        throw conflictError();
      }
      await wait(attempt);
    }
  }

  throw conflictError();
}

export function isRetryableTransactionError(error: unknown): boolean {
  return hasRetryableCode(error, new Set(), 0);
}

function hasRetryableCode(
  value: unknown,
  visited: Set<object>,
  depth: number
): boolean {
  if (!value || typeof value !== "object" || depth > 4) {
    return false;
  }
  if (visited.has(value)) {
    return false;
  }
  visited.add(value);

  const record = value as Readonly<Record<string, unknown>>;
  const code = [record.code, record.originalCode, record.sqlState].find(
    (candidate): candidate is string => typeof candidate === "string"
  );
  if (code && RETRYABLE_TRANSACTION_CODES.has(code)) {
    return true;
  }

  return [record.cause, record.meta, record.driverAdapterError].some((nested) =>
    hasRetryableCode(nested, visited, depth + 1)
  );
}

async function waitBeforeRetry(attempt: number): Promise<void> {
  const delayMilliseconds = Math.min(5 * 2 ** (attempt - 1), 50);
  await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
}
