import { createHash } from "node:crypto";
import {
  connect,
  constants,
  type ClientHttp2Session,
  type IncomingHttpHeaders
} from "node:http2";
import type { TokenEncryptionProvider } from "../mail/token-encryption.js";
import type {
  PushTransport,
  PushTransportInput,
  PushTransportResult
} from "./push-transport.js";
import type { ApnsConfiguration } from "./apns-config.js";
import { ApnsProviderToken } from "./apns-jwt.js";
import { validProviderRequestId } from "./prisma-push-delivery-queue.js";

const endpoints = {
  sandbox: "https://api.sandbox.push.apple.com:443",
  production: "https://api.push.apple.com:443"
} as const;
const notificationText = {
  title: "Call Now",
  body: "登録した条件に一致するメールが届きました。タップして確認してください。"
} as const;
const retry = (
  code: string,
  retryAfterMs = 1000,
  stop?: true
): PushTransportResult => ({
  kind: "RETRY",
  code,
  retryAfterMs,
  ...(stop ? { stop } : {})
});
const configurationFailure = (): PushTransportResult =>
  retry("APNS_CONFIG", 300_000, true);

export function apnsRequestId(idempotencyKey: string): string {
  const bytes = createHash("sha256")
    .update(`apns-push-v1:${idempotencyKey}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function apnsPayload(alertId: string): string {
  if (!validProviderRequestId(alertId))
    throw new Error("APNS_ALERT_ID_INVALID");
  const payload = JSON.stringify({
    aps: {
      alert: notificationText,
      sound: "callnow-alarm.caf",
      "interruption-level": "time-sensitive",
      "thread-id": "callnow-alerts",
      category: "CALLNOW_ALERT"
    },
    callnow: { v: 1, alertId }
  });
  if (Buffer.byteLength(payload) >= 4096)
    throw new Error("APNS_PAYLOAD_INVALID");
  return payload;
}

type Response = { status: number; body: string; headers: IncomingHttpHeaders };
type Exchange = Response | { connection: true; reason?: string };

export class ApnsHttp2Transport implements PushTransport {
  public readonly mode = "apns";
  private session: ClientHttp2Session | undefined;
  private closed = false;
  private readonly jwt: ApnsProviderToken;
  private constructor(
    private readonly configuration: ApnsConfiguration,
    private readonly encryption: TokenEncryptionProvider,
    private readonly connector: () => ClientHttp2Session,
    private readonly now: () => number,
    private readonly timeoutMs: number
  ) {
    this.jwt = new ApnsProviderToken(configuration, now);
  }

  public static create(
    configuration: ApnsConfiguration,
    encryption: TokenEncryptionProvider
  ): ApnsHttp2Transport {
    // Fixed endpoint, default Node TLS verification. No URL/TLS override from env/CLI.
    return new ApnsHttp2Transport(
      configuration,
      encryption,
      () => connect(endpoints[configuration.environment]),
      Date.now,
      10_000
    );
  }
  public static forTest(
    configuration: ApnsConfiguration,
    encryption: TokenEncryptionProvider,
    connector: () => ClientHttp2Session,
    options: { now?: () => number; timeoutMs?: number } = {}
  ): ApnsHttp2Transport {
    if (process.env.NODE_ENV !== "test")
      throw new Error("APNS_TEST_FACTORY_FORBIDDEN");
    return new ApnsHttp2Transport(
      configuration,
      encryption,
      connector,
      options.now ?? Date.now,
      options.timeoutMs ?? 10_000
    );
  }
  public close(): void {
    this.closed = true;
    this.invalidate(this.session);
  }
  private invalidate(session: ClientHttp2Session | undefined): void {
    if (this.session === session) this.session = undefined;
    // Active streams are failed/retried, never incorrectly accepted. No raw error is logged.
    if (session && !session.destroyed) session.destroy();
  }
  private getSession(): ClientHttp2Session {
    if (this.closed) throw new Error("APNS_TRANSPORT_CLOSED");
    if (!this.session || this.session.closed || this.session.destroyed) {
      const session = this.connector();
      this.session = session;
      session.on("error", () => this.invalidate(session));
      session.on("close", () => this.invalidate(session));
      // Keep a listener even when there are no active requests. Per-stream listeners classify GOAWAY.
      session.on("goaway", () => {
        if (this.session === session) this.session = undefined;
        queueMicrotask(() => this.invalidate(session));
      });
    }
    return this.session;
  }

  public async send(
    input: PushTransportInput,
    signal: AbortSignal
  ): Promise<PushTransportResult> {
    if (signal.aborted || this.closed) return retry("APNS_CONNECTION");
    let token: string, jwt: string, payload: string;
    try {
      if (
        !input.encryptedToken ||
        !input.confirmCurrent ||
        !/^[a-f0-9]{64}$/u.test(input.idempotencyKey)
      )
        return configurationFailure();
      const envelope: unknown = JSON.parse(input.encryptedToken);
      if (!envelope || typeof envelope !== "object")
        return configurationFailure();
      const e = envelope as Record<string, unknown>;
      if (
        ![e.ciphertext, e.provider, e.keyVersion].every(
          (v) => typeof v === "string" && v.length > 0
        )
      )
        return configurationFailure();
      token = await this.encryption.decrypt({
        ciphertext: e.ciphertext as string,
        provider: e.provider as string,
        keyVersion: e.keyVersion as string
      });
      if (!/^(?:[a-fA-F0-9]{2}){1,512}$/u.test(token))
        return configurationFailure();
      jwt = await this.jwt.get();
      payload = apnsPayload(input.alertId);
      if (signal.aborted || this.closed) return retry("APNS_CONNECTION");
      // Closes the prepare -> async decrypt/sign window; an AFTER-check rotation can still race with I/O.
      if (!(await input.confirmCurrent()))
        return { kind: "PERMANENT", code: "APNS_TARGET_STALE" };
    } catch {
      return configurationFailure();
    }
    if (signal.aborted || this.closed) return retry("APNS_CONNECTION");
    const requestId = apnsRequestId(input.idempotencyKey);
    let response: Exchange;
    try {
      response = await this.exchange(
        token,
        jwt,
        payload,
        requestId,
        input.alertId,
        signal
      );
    } catch {
      this.invalidate(this.session);
      return retry("APNS_CONNECTION");
    }
    if ("connection" in response) {
      if (
        response.reason &&
        !["Shutdown", "IdleTimeout", "UnrelatedKeyIdInToken"].includes(
          response.reason
        )
      )
        return configurationFailure();
      return retry("APNS_CONNECTION");
    }
    const { status, headers } = response;
    if (status === 200) {
      const returnedId = headers["apns-id"];
      return {
        kind: "ACCEPTED",
        providerRequestId:
          typeof returnedId === "string" &&
          validProviderRequestId(returnedId) &&
          returnedId.toLowerCase() === requestId
            ? returnedId
            : requestId
      };
    }
    let reason: unknown;
    try {
      reason = (JSON.parse(response.body) as { reason?: unknown }).reason;
    } catch {
      return configurationFailure();
    }
    if (typeof reason !== "string") return configurationFailure();
    if (status === 410 && ["Unregistered", "ExpiredToken"].includes(reason))
      return { kind: "PERMANENT", code: "HTTP_410" };
    if (status === 400 && reason === "BadDeviceToken")
      return { kind: "PERMANENT", code: "APNS_BAD_DEVICE_TOKEN" };
    if (status === 400 && reason === "DeviceTokenNotForTopic")
      return { kind: "PERMANENT", code: "APNS_TOKEN_NOT_FOR_TOPIC" };
    if (
      (status === 503 && reason === "Shutdown") ||
      (status === 400 && reason === "IdleTimeout") ||
      (status === 403 && reason === "UnrelatedKeyIdInToken")
    ) {
      this.invalidate(this.session);
      return retry("APNS_CONNECTION");
    }
    if (status === 403 && reason === "ExpiredProviderToken") {
      try {
        return (await this.jwt.expired(jwt))
          ? retry("APNS_TOKEN_REFRESH")
          : configurationFailure();
      } catch {
        return configurationFailure();
      }
    }
    if (status === 429 && reason === "TooManyRequests")
      return retry("HTTP_429", this.retryAfter(headers));
    if (
      (status === 500 &&
        ["InternalServerError", "ServiceUnavailable"].includes(reason)) ||
      (status === 503 && reason === "ServiceUnavailable")
    )
      return retry("HTTP_5XX", Math.max(900_000, this.retryAfter(headers)));
    // Prefer the loss-prevention invariant over the contradictory PERMANENT rows in the proposal.
    if (status === 403 && reason === "Forbidden")
      return retry("APNS_FORBIDDEN", 300_000, true);
    if (status === 413 && reason === "PayloadTooLarge")
      return retry("APNS_PAYLOAD_TOO_LARGE", 300_000, true);
    return configurationFailure();
  }

  private retryAfter(headers: IncomingHttpHeaders): number {
    const raw = headers["retry-after"];
    if (typeof raw !== "string") return 1000;
    const delay = /^\d+$/u.test(raw)
      ? Number(raw) * 1000
      : Date.parse(raw) - this.now();
    return Number.isFinite(delay)
      ? Math.min(604800_000, Math.max(1000, Math.ceil(delay)))
      : 1000;
  }

  private exchange(
    token: string,
    jwt: string,
    payload: string,
    requestId: string,
    alertId: string,
    signal: AbortSignal
  ): Promise<Exchange> {
    const session = this.getSession();
    const stream = session.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": this.configuration.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(
        Math.floor(this.now() / 1000) + this.configuration.expirationSeconds
      ),
      "apns-collapse-id": createHash("sha256")
        .update(`callnow-alert-v1:${alertId}`)
        .digest("hex"),
      "apns-id": requestId,
      "content-type": "application/json"
    });
    return new Promise((resolve) => {
      let done = false,
        size = 0,
        body = "",
        headers: IncomingHttpHeaders = {};
      const finish = (result: Exchange) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        session.removeListener("goaway", goaway);
        if (!stream.closed) stream.close(constants.NGHTTP2_CANCEL);
        resolve(result);
      };
      const abort = () => {
        finish({ connection: true });
        this.invalidate(session);
      };
      const goaway = (_code: number, _last: number, data?: Buffer) => {
        let reason: string | undefined;
        if (data?.length) {
          try {
            const parsed: unknown = JSON.parse(
              data.length <= 4096 ? data.toString("utf8") : "invalid"
            );
            const r =
              parsed && typeof parsed === "object" && "reason" in parsed
                ? parsed.reason
                : undefined;
            reason = typeof r === "string" ? r : "UNKNOWN";
          } catch {
            reason = "UNKNOWN";
          }
        }
        finish({ connection: true, ...(reason ? { reason } : {}) });
      };
      const timer = setTimeout(abort, this.timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      session.on("goaway", goaway);
      stream.on("error", abort);
      stream.on("aborted", abort);
      stream.on("close", () => {
        if (!done) abort();
      });
      stream.on("response", (h) => {
        headers = h;
      });
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        size += Buffer.byteLength(chunk);
        if (size > 4096) finish({ status: 0, body: "", headers: {} });
        else body += chunk;
      });
      stream.on("end", () =>
        finish({ status: Number(headers[":status"]), body, headers })
      );
      if (signal.aborted) abort();
      else stream.end(payload);
    });
  }
}
