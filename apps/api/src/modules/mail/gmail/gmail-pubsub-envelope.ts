import { AppError } from "../../../lib/app-error.js";

const MAX_DECODED_DATA_BYTES = 8_192;

export interface GmailPubSubNotification {
  readonly messageId: string;
  readonly publishTime: Date;
  readonly emailAddress: string;
  readonly historyId: string;
}

export function parseGmailPubSubEnvelope(
  value: unknown
): GmailPubSubNotification {
  const envelope = strictRecord(value, [
    "message",
    "subscription",
    "deliveryAttempt"
  ]);
  const message = strictRecord(envelope.message, [
    "messageId",
    "data",
    "publishTime",
    "attributes",
    "orderingKey"
  ]);
  const messageId = boundedString(message.messageId, 1, 255);
  const publishTimeValue = boundedString(message.publishTime, 1, 64);
  const encodedData = boundedString(message.data, 1, 16_384);
  if (/[^\x20-\x7e]/u.test(messageId)) throw invalidEnvelope();
  const publishTime = new Date(publishTimeValue);
  if (Number.isNaN(publishTime.getTime())) throw invalidEnvelope();

  const decoded = decodeStrictBase64(encodedData);
  let payload: unknown;
  try {
    payload = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw invalidEnvelope();
  }
  const data = strictRecord(payload, ["emailAddress", "historyId"]);
  const emailAddress = boundedString(data.emailAddress, 3, 320)
    .trim()
    .toLowerCase();
  const historyId = boundedString(data.historyId, 1, 64);
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(emailAddress) ||
    !/^\d+$/u.test(historyId)
  ) {
    throw invalidEnvelope();
  }
  return { messageId, publishTime, emailAddress, historyId };
}

function decodeStrictBase64(value: string): Buffer {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value
    )
  ) {
    throw invalidEnvelope();
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.length > MAX_DECODED_DATA_BYTES) {
    throw invalidEnvelope();
  }
  return decoded;
}

function strictRecord(
  value: unknown,
  allowedKeys: readonly string[]
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidEnvelope();
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
    throw invalidEnvelope();
  }
  return record;
}

function boundedString(
  value: unknown,
  minimumLength: number,
  maximumLength: number
): string {
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    /[\r\n\0]/u.test(value)
  ) {
    throw invalidEnvelope();
  }
  return value;
}

function invalidEnvelope(): AppError {
  return new AppError(
    "GMAIL_PUBSUB_ENVELOPE_INVALID",
    "The push request body is invalid.",
    400
  );
}
