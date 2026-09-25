import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { LocalAesGcmTokenEncryptionProvider } from "../mail/token-encryption.js";
import { readApnsConfiguration } from "./apns-config.js";
import { createConfiguredApnsTransport } from "./apns-runtime.js";
import { validProviderRequestId } from "./prisma-push-delivery-queue.js";
import {
  pushIdempotencyKey,
  type PushTransportResult
} from "./push-transport.js";

type TokenSource = { kind: "stdin" } | { kind: "file"; path: string };
type SmokeOutput =
  | { result: "ACCEPTED"; apnsId: string }
  | { result: "RETRY" | "PERMANENT"; code: string };
const safeCodes = new Set([
  "HTTP_410",
  "HTTP_429",
  "HTTP_5XX",
  "APNS_CONFIG",
  "APNS_CONNECTION",
  "APNS_TOKEN_REFRESH",
  "APNS_BAD_DEVICE_TOKEN",
  "APNS_TOKEN_NOT_FOR_TOPIC",
  "APNS_TARGET_STALE",
  "APNS_FORBIDDEN",
  "APNS_PAYLOAD_TOO_LARGE"
]);

function tokenSource(args: readonly string[]): TokenSource {
  let source: TokenSource | undefined;
  let confirmation = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--confirm-real-push" && !confirmation) confirmation = true;
    else if (args[i] === "--token-stdin" && !source) source = { kind: "stdin" };
    else if (args[i] === "--token-file" && !source) {
      const path = args[++i];
      if (!path || path.startsWith("--")) throw new Error("SMOKE_ARGUMENTS");
      source = { kind: "file", path };
    } else throw new Error("SMOKE_ARGUMENTS");
  }
  if (!source || !confirmation) throw new Error("SMOKE_ARGUMENTS");
  return source;
}

function readToken(stream: Readable, signal: AbortSignal): Promise<string> {
  // Bound input; do not echo paths or data, and do not wait forever after Ctrl-C.
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0,
      done = false;
    const finish = (error?: true) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", abort);
      stream.removeListener("data", data);
      stream.removeListener("end", end);
      stream.removeListener("close", close);
      // Keep the safe error listener until close; destroy must never expose raw I/O errors.
      stream.destroy();
      const token = error ? "" : Buffer.concat(chunks).toString("utf8").trim();
      if (!/^(?:[a-fA-F0-9]{2}){1,512}$/u.test(token))
        reject(new Error("SMOKE_TOKEN_INPUT"));
      else resolve(token.toLowerCase());
    };
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 4096) finish(true);
      else chunks.push(bytes);
    };
    const end = () => finish();
    const abort = () => finish(true);
    const close = () => {
      if (!done) finish(true);
    };
    stream.on("error", abort);
    stream.once("close", () => stream.removeListener("error", abort));
    stream.on("data", data);
    stream.once("end", end);
    stream.once("close", close);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted || stream.destroyed) finish(true);
  });
}

function safeOutput(result: PushTransportResult): SmokeOutput {
  if (
    result.kind === "ACCEPTED" &&
    validProviderRequestId(result.providerRequestId)
  )
    return { result: "ACCEPTED", apnsId: result.providerRequestId };
  if (result.kind !== "ACCEPTED" && safeCodes.has(result.code))
    return { result: result.kind, code: result.code };
  return { result: "PERMANENT", code: "APNS_SMOKE_RESULT_INVALID" };
}

// No process startup on import. Tests call this runner with local HTTP/2 intercepted
// at node:http2, never the actual command. No DB, worker, retry loop or live-data Alert.
export async function runApnsSmoke(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  io: { stdin: Readable; write: (line: string) => void; signal: AbortSignal }
): Promise<0 | 1> {
  const output = (value: SmokeOutput): 0 | 1 => {
    io.write(`${JSON.stringify(value)}\n`);
    return value.result === "ACCEPTED" ? 0 : 1;
  };
  // BEFORE parsing other flags, reading configuration/files/stdin, or building transport.
  if (!args.includes("--confirm-real-push"))
    return output({
      result: "PERMANENT",
      code: "APNS_SMOKE_CONFIRMATION_REQUIRED"
    });
  if (env.APP_ENV === "production")
    return output({ result: "PERMANENT", code: "APNS_PRODUCTION_FORBIDDEN" });
  let failureCode = "APNS_SMOKE_ARGUMENTS_INVALID";
  let transport:
    ReturnType<typeof createConfiguredApnsTransport>["transport"] | undefined;
  try {
    const source = tokenSource(args);
    failureCode = "APNS_CONFIGURATION_INVALID";
    // Validate original environment FIRST: missing/invalid APNS_ENVIRONMENT is NOT silently fixed.
    readApnsConfiguration(env);
    if (io.signal.aborted) throw new Error("SMOKE_STOPPED");
    failureCode = "APNS_SMOKE_TOKEN_INPUT_INVALID";
    const token = await readToken(
      source.kind === "stdin"
        ? io.stdin
        : createReadStream(source.path, {
            highWaterMark: 4097
          }),
      io.signal
    );
    failureCode = "APNS_SMOKE_FAILED";
    if (io.signal.aborted) throw new Error("SMOKE_STOPPED");
    // Ephemeral encryption only, independent of DB credentials and configured KMS.
    // Same envelope/path as PR07c; no token persistence and no extra cloud calls.
    const key = randomBytes(32).toString("base64"),
      version = "apns-smoke-ephemeral";
    const encryption = new LocalAesGcmTokenEncryptionProvider(key, version);
    const encryptedToken = JSON.stringify(await encryption.encrypt(token));
    transport = createConfiguredApnsTransport({
      ...env,
      APNS_ENVIRONMENT: "sandbox",
      MAIL_TOKEN_ENCRYPTION_PROVIDER: "local",
      MAIL_TOKEN_ENCRYPTION_KEY: key,
      MAIL_TOKEN_ENCRYPTION_KEY_VERSION: version
    }).transport;
    const alertId = randomUUID();
    const result = await transport.send(
      {
        deliveryId: randomUUID(),
        recipientId: randomUUID(),
        alertId,
        endpointKey: randomUUID(),
        endpointVersion: 1,
        attemptId: randomUUID(),
        idempotencyKey: pushIdempotencyKey(randomUUID(), randomUUID(), 1),
        encryptedToken,
        // Synthetic one-shot input, not a registry record or a real Alert.
        confirmCurrent: async () => !io.signal.aborted
      },
      io.signal
    );
    return output(safeOutput(result));
  } catch {
    return output({
      result: "PERMANENT",
      code: io.signal.aborted ? "APNS_SMOKE_CANCELLED" : failureCode
    });
  } finally {
    transport?.close();
  }
}
