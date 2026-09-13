import { describe, expect, it } from "vitest";
import type {
  GmailMessage,
  GmailMessagePart
} from "../src/modules/mail/gmail/gmail-api-client.js";
import {
  extractGmailMatchContent,
  htmlToVisibleText
} from "../src/modules/mail/gmail/gmail-message-content.js";
import { findFirstMatchingKeyword } from "../src/modules/mail/gmail/gmail-keyword-matcher.js";

describe("Gmail MIME extraction", () => {
  it("extracts subject, plain text, nested HTML, and base64url UTF-8 safely", () => {
    const message = createMessage({
      headers: [
        { name: "Subject", value: "=?UTF-8?B?5YGc6Zu744Gu44GK55+l44KJ44Gb?=" }
      ],
      parts: [
        textPart("text/plain", "東京 電力からの案内"),
        {
          ...part("multipart/alternative"),
          parts: [
            textPart(
              "text/html",
              "<style>.hidden{display:none}</style><p>Call <strong>Now</strong></p><script>alert(1)</script>"
            )
          ]
        }
      ]
    });

    const content = extractGmailMatchContent(message);
    expect(content.subject).toBe("停電のお知らせ");
    expect(content.body).toContain("東京 電力からの案内");
    expect(content.body).toContain("Call Now");
    expect(content.body).not.toContain("alert(1)");
  });

  it("ignores attachments and uses snippet only when body text is empty", () => {
    const message = createMessage({
      snippet: "博衣こよりからのお知らせ",
      parts: [
        {
          ...textPart("text/plain", "添付内の機密テキスト"),
          filename: "secret.txt",
          body: {
            size: 30,
            data: null,
            attachmentId: "attachment-1"
          }
        }
      ]
    });
    expect(extractGmailMatchContent(message).body).toBe(
      "博衣こよりからのお知らせ"
    );
  });

  it("caps extracted body text without fetching binary attachments", () => {
    const content = extractGmailMatchContent(
      createMessage({ parts: [textPart("text/plain", "a".repeat(2_000))] }),
      256
    );
    expect(Buffer.byteLength(content.body, "utf8")).toBeLessThanOrEqual(256);

    const multibyte = extractGmailMatchContent(
      createMessage({ parts: [textPart("text/plain", "あ".repeat(200))] }),
      257
    );
    expect(Buffer.byteLength(multibyte.body, "utf8")).toBeLessThanOrEqual(257);

    const combined = extractGmailMatchContent(
      createMessage({
        headers: [{ name: "Subject", value: "s".repeat(200) }],
        parts: Array.from({ length: 20 }, () =>
          textPart("text/plain", "b".repeat(20))
        )
      }),
      256
    );
    expect(
      Buffer.byteLength(combined.subject, "utf8") +
        Buffer.byteLength(combined.body, "utf8")
    ).toBeLessThanOrEqual(256);
  });

  it("converts HTML entities and block boundaries to visible text", () => {
    expect(htmlToVisibleText("<p>A&amp;B</p><div>&#x505c;&#38651;</div>")).toBe(
      "A&B\n停電"
    );
    expect(htmlToVisibleText("<p>visible</p><script>hidden forever")).toBe(
      "visible"
    );
  });
});

describe("Gmail keyword matching", () => {
  it.each([
    ["博衣こより", "【博衣こより】配信予定"],
    ["山田 太郎", "山田　太郎から連絡"],
    ["Ｃａｌｌ Ｎｏｗ", "call now service"],
    ["東京 電力", "東京   電力からの停電連絡"]
  ])(
    "matches canonical keyword %s with NFKC and case normalization",
    (keyword, text) => {
      expect(
        findFirstMatchingKeyword([keyword], { subject: text, body: "" })
      ).toBe(keyword);
    }
  );

  it("returns the first configured keyword and never creates one result per match", () => {
    expect(
      findFirstMatchingKeyword(["停電", "お知らせ"], {
        subject: "停電のお知らせ",
        body: ""
      })
    ).toBe("停電");
  });

  it("returns null when neither subject nor body matches", () => {
    expect(
      findFirstMatchingKeyword(["停電"], {
        subject: "定期連絡",
        body: "通常どおりです"
      })
    ).toBeNull();
  });

  it("ignores empty and duplicate normalized keywords", () => {
    expect(
      findFirstMatchingKeyword(["", "　", "停電", "停電"], {
        subject: "停電のお知らせ",
        body: ""
      })
    ).toBe("停電");
  });
});

function createMessage(input: {
  readonly headers?: GmailMessagePart["headers"];
  readonly parts?: GmailMessagePart["parts"];
  readonly snippet?: string;
}): GmailMessage {
  return {
    id: "message-1",
    internalDate: "1788307200000",
    labelIds: ["INBOX"],
    snippet: input.snippet ?? "",
    payload: {
      ...part("multipart/mixed"),
      headers: input.headers ?? [],
      parts: input.parts ?? []
    }
  };
}

function textPart(mimeType: string, value: string): GmailMessagePart {
  return {
    ...part(mimeType),
    body: {
      size: Buffer.byteLength(value, "utf8"),
      data: Buffer.from(value, "utf8").toString("base64url"),
      attachmentId: null
    }
  };
}

function part(mimeType: string): GmailMessagePart {
  return {
    mimeType,
    filename: "",
    headers: [],
    body: { size: 0, data: null, attachmentId: null },
    parts: []
  };
}
