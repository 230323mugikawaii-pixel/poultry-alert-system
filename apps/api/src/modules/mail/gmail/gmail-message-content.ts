import type { GmailMessage, GmailMessagePart } from "./gmail-api-client.js";

export const MAX_GMAIL_MATCH_TEXT_BYTES = 1_048_576;

export interface GmailMatchContent {
  readonly subject: string;
  readonly body: string;
}

export function extractGmailMatchContent(
  message: GmailMessage,
  maximumBytes = MAX_GMAIL_MATCH_TEXT_BYTES
): GmailMatchContent {
  const subject = capUtf8(
    decodeHeaderValue(
      message.payload.headers.find(
        ({ name }) => name.toLocaleLowerCase("en-US") === "subject"
      )?.value ?? ""
    ),
    maximumBytes
  );
  const budget = {
    remaining: Math.max(maximumBytes - Buffer.byteLength(subject, "utf8"), 0)
  };
  const bodyBudget = budget.remaining;
  const textParts: string[] = [];
  collectTextParts(message.payload, textParts, budget);
  const body = capUtf8(textParts.join("\n").trim(), bodyBudget);
  return {
    subject,
    body: body || capUtf8(message.snippet, bodyBudget)
  };
}

function collectTextParts(
  part: GmailMessagePart,
  output: string[],
  budget: { remaining: number }
): void {
  if (budget.remaining <= 0) return;
  if (part.filename || part.body.attachmentId) return;

  const mimeType = part.mimeType.toLocaleLowerCase("en-US").split(";", 1)[0];
  if (
    (mimeType === "text/plain" || mimeType === "text/html") &&
    part.body.data
  ) {
    const decoded = decodeBase64UrlText(part.body.data, budget.remaining);
    const visibleText =
      mimeType === "text/html" ? htmlToVisibleText(decoded) : decoded;
    const capped = capUtf8(visibleText, budget.remaining).trim();
    if (capped) {
      output.push(capped);
      budget.remaining -= Buffer.byteLength(capped, "utf8");
    }
  }

  for (const child of part.parts) {
    collectTextParts(child, output, budget);
    if (budget.remaining <= 0) break;
  }
}

export function decodeBase64UrlText(
  value: string,
  maximumBytes: number
): string {
  if (
    value.length === 0 ||
    value.length > Math.ceil(MAX_GMAIL_MATCH_TEXT_BYTES / 3) * 4 + 8 ||
    !/^[A-Za-z0-9_-]+={0,2}$/u.test(value) ||
    value.length % 4 === 1
  ) {
    throw new Error("gmail_message_body_invalid");
  }
  const decoded = Buffer.from(value, "base64url");
  return capUtf8(decoded.toString("utf8"), maximumBytes);
}

export function htmlToVisibleText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<!--[\s\S]*?-->/gu, " ")
      .replace(
        /<(script|style|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu,
        " "
      )
      .replace(/<(br|hr)\b[^>]*>/giu, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])\s*>/giu, "\n")
      .replace(/<[^>]*>/gu, " ")
  )
    .replace(/[\t\f\v ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"'
  };
  return value.replace(
    /&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z]{2,8}));/giu,
    (
      match,
      decimal: string | undefined,
      hexadecimal: string | undefined,
      name: string | undefined
    ) => {
      if (name) return named[name.toLocaleLowerCase("en-US")] ?? match;
      const codePoint = Number.parseInt(
        decimal ?? hexadecimal ?? "",
        hexadecimal ? 16 : 10
      );
      return Number.isInteger(codePoint) &&
        codePoint > 0 &&
        codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
  );
}

function decodeHeaderValue(value: string): string {
  return value.replace(
    /=\?utf-8\?([bq])\?([^?]+)\?=/giu,
    (_match, encoding: string, payload: string) => {
      try {
        if (encoding.toLocaleLowerCase("en-US") === "b") {
          return Buffer.from(payload, "base64").toString("utf8");
        }
        return decodeQuotedPrintableHeader(payload);
      } catch {
        return "";
      }
    }
  );
}

function decodeQuotedPrintableHeader(value: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "_") {
      bytes.push(0x20);
      continue;
    }
    const hexadecimal = value.slice(index + 1, index + 3);
    if (character === "=" && /^[\da-f]{2}$/iu.test(hexadecimal)) {
      bytes.push(Number.parseInt(hexadecimal, 16));
      index += 2;
      continue;
    }
    bytes.push(...Buffer.from(character, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

function capUtf8(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}
