import { describe, expect, it, vi } from "vitest";
import { GoogleGmailApiClient } from "../src/modules/mail/gmail/gmail-api-client.js";

describe("Google Gmail API client", () => {
  it("starts an INBOX-only watch and validates the returned cursor and expiration", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        historyId: "90071992547409930000",
        expiration: "1789000000000"
      })
    );
    const client = new GoogleGmailApiClient({ fetch: fetcher });
    await expect(
      client.startWatch(
        "synthetic-access-token",
        "projects/call-now/topics/gmail-push"
      )
    ).resolves.toMatchObject({ historyId: "90071992547409930000" });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/watch");
    const body = init?.body;
    if (typeof body !== "string") throw new Error("Expected a JSON body");
    expect(JSON.parse(body)).toEqual({
      topicName: "projects/call-now/topics/gmail-push",
      labelIds: ["INBOX"],
      labelFilterBehavior: "include"
    });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer synthetic-access-token"
    );
  });

  it("retries 429 and 5xx with bounded backoff, then succeeds", async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(
        jsonResponse({ historyId: "10", expiration: "1789000000000" })
      );
    const client = new GoogleGmailApiClient({
      fetch: fetcher,
      wait,
      random: () => 0
    });
    await client.startWatch(
      "synthetic-access-token",
      "projects/call-now/topics/gmail-push"
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("does not retry a stale-history 404 so recovery can run", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({}, 404));
    const client = new GoogleGmailApiClient({ fetch: fetcher });
    await expect(
      client.listHistory({
        accessToken: "synthetic-access-token",
        startHistoryId: "10",
        pageToken: null
      })
    ).rejects.toMatchObject({
      status: 404,
      errorCode: "GMAIL_HTTP_404"
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses fixed Gmail hosts and escaped message IDs", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        id: "message_1",
        labelIds: ["INBOX"],
        snippet: "",
        payload: { mimeType: "text/plain", headers: [], body: {} }
      })
    );
    const client = new GoogleGmailApiClient({ fetch: fetcher });
    await client.getMessage("synthetic-access-token", "message_1");
    expect(String(fetcher.mock.calls[0]?.[0])).toMatch(
      /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/message_1\?format=full$/u
    );
    await expect(
      client.getMessage("synthetic-access-token", "https://evil.example")
    ).rejects.toMatchObject({ errorCode: "GMAIL_IDENTIFIER_INVALID" });
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
