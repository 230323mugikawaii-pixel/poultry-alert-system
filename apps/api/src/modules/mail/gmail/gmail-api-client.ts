const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const DEFAULT_TIMEOUT_MILLISECONDS = 15_000;
const DEFAULT_MAXIMUM_ATTEMPTS = 3;

export interface GmailWatchResult {
  readonly historyId: string;
  readonly expiration: Date;
}

export interface GmailHistoryMessageAdded {
  readonly message: {
    readonly id: string;
    readonly labelIds: readonly string[];
  };
}

export interface GmailHistoryRecord {
  readonly id: string;
  readonly messagesAdded: readonly GmailHistoryMessageAdded[];
}

export interface GmailHistoryPage {
  readonly history: readonly GmailHistoryRecord[];
  readonly nextPageToken: string | null;
  readonly currentHistoryId: string;
}

export interface GmailMessagePart {
  readonly mimeType: string;
  readonly filename: string;
  readonly headers: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly body: {
    readonly size: number;
    readonly data: string | null;
    readonly attachmentId: string | null;
  };
  readonly parts: readonly GmailMessagePart[];
}

export interface GmailMessage {
  readonly id: string;
  readonly internalDate: string | null;
  readonly labelIds: readonly string[];
  readonly snippet: string;
  readonly payload: GmailMessagePart;
}

export interface GmailMessageListPage {
  readonly messageIds: readonly string[];
  readonly nextPageToken: string | null;
}

export interface GmailApiClient {
  startWatch(accessToken: string, topicName: string): Promise<GmailWatchResult>;
  stopWatch(accessToken: string): Promise<void>;
  listHistory(input: {
    readonly accessToken: string;
    readonly startHistoryId: string;
    readonly pageToken: string | null;
  }): Promise<GmailHistoryPage>;
  getMessage(accessToken: string, messageId: string): Promise<GmailMessage>;
  listRecentInboxMessages(input: {
    readonly accessToken: string;
    readonly after: Date;
    readonly pageToken: string | null;
  }): Promise<GmailMessageListPage>;
}

export class GmailApiRequestError extends Error {
  public constructor(
    public readonly status: number | null,
    public readonly errorCode: string
  ) {
    super("gmail_api_request_failed");
    this.name = "GmailApiRequestError";
  }
}

export class GoogleGmailApiClient implements GmailApiClient {
  public constructor(
    private readonly options: {
      readonly fetch?: typeof fetch;
      readonly timeoutMilliseconds?: number;
      readonly maximumAttempts?: number;
      readonly wait?: (milliseconds: number) => Promise<void>;
      readonly random?: () => number;
    } = {}
  ) {}

  public async startWatch(
    accessToken: string,
    topicName: string
  ): Promise<GmailWatchResult> {
    const response = await this.request<unknown>(
      `${GMAIL_API_BASE}/watch`,
      accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          topicName,
          labelIds: ["INBOX"],
          labelFilterBehavior: "include"
        })
      }
    );
    const record = readRecord(response);
    const historyId = readHistoryId(record?.historyId);
    const expirationMilliseconds = readDecimalString(record?.expiration);
    if (!historyId || !expirationMilliseconds) {
      throw new GmailApiRequestError(null, "GMAIL_WATCH_RESPONSE_INVALID");
    }
    const expiration = new Date(Number(expirationMilliseconds));
    if (Number.isNaN(expiration.getTime())) {
      throw new GmailApiRequestError(null, "GMAIL_WATCH_RESPONSE_INVALID");
    }
    return { historyId, expiration };
  }

  public async stopWatch(accessToken: string): Promise<void> {
    await this.request<unknown>(`${GMAIL_API_BASE}/stop`, accessToken, {
      method: "POST",
      body: "{}"
    });
  }

  public async listHistory(input: {
    readonly accessToken: string;
    readonly startHistoryId: string;
    readonly pageToken: string | null;
  }): Promise<GmailHistoryPage> {
    const url = new URL(`${GMAIL_API_BASE}/history`);
    url.searchParams.set("startHistoryId", input.startHistoryId);
    url.searchParams.set("historyTypes", "messageAdded");
    url.searchParams.set("labelId", "INBOX");
    url.searchParams.set("maxResults", "100");
    if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
    const response = await this.request<unknown>(
      url.toString(),
      input.accessToken
    );
    const record = readRecord(response);
    const currentHistoryId = readHistoryId(record?.historyId);
    if (!currentHistoryId) {
      throw new GmailApiRequestError(null, "GMAIL_HISTORY_RESPONSE_INVALID");
    }
    const rawHistory = Array.isArray(record?.history) ? record.history : [];
    const history = rawHistory.map(parseHistoryRecord);
    const nextPageToken = readOptionalBoundedString(
      record?.nextPageToken,
      2048
    );
    return { history, nextPageToken, currentHistoryId };
  }

  public async getMessage(
    accessToken: string,
    messageId: string
  ): Promise<GmailMessage> {
    assertGmailIdentifier(messageId);
    const url = new URL(
      `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}`
    );
    url.searchParams.set("format", "full");
    const response = await this.request<unknown>(url.toString(), accessToken);
    return parseMessage(response);
  }

  public async listRecentInboxMessages(input: {
    readonly accessToken: string;
    readonly after: Date;
    readonly pageToken: string | null;
  }): Promise<GmailMessageListPage> {
    const url = new URL(`${GMAIL_API_BASE}/messages`);
    const unixSeconds = Math.floor(input.after.getTime() / 1000);
    url.searchParams.set(
      "q",
      `after:${unixSeconds} in:inbox -in:sent -in:drafts -in:spam -in:trash`
    );
    url.searchParams.set("maxResults", "100");
    if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
    const response = await this.request<unknown>(
      url.toString(),
      input.accessToken
    );
    const record = readRecord(response);
    const messages = Array.isArray(record?.messages) ? record.messages : [];
    return {
      messageIds: messages.map((message) => {
        const id = readRecord(message)?.id;
        if (typeof id !== "string") {
          throw new GmailApiRequestError(
            null,
            "GMAIL_MESSAGE_LIST_RESPONSE_INVALID"
          );
        }
        assertGmailIdentifier(id);
        return id;
      }),
      nextPageToken: readOptionalBoundedString(record?.nextPageToken, 2048)
    };
  }

  private async request<T>(
    url: string,
    accessToken: string,
    init: RequestInit = {}
  ): Promise<T> {
    if (!accessToken || /[\r\n\0]/u.test(accessToken)) {
      throw new GmailApiRequestError(null, "GMAIL_ACCESS_TOKEN_INVALID");
    }
    const fetchImplementation = this.options.fetch ?? fetch;
    const attempts = this.options.maximumAttempts ?? DEFAULT_MAXIMUM_ATTEMPTS;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS
      );
      try {
        const response = await fetchImplementation(url, {
          ...init,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${accessToken}`,
            ...(init.body ? { "content-type": "application/json" } : {})
          },
          signal: controller.signal
        });
        if (response.ok) {
          if (response.status === 204) return undefined as T;
          return (await response.json()) as T;
        }
        const requestError = new GmailApiRequestError(
          response.status,
          `GMAIL_HTTP_${response.status}`
        );
        if (!isRetryableStatus(response.status) || attempt === attempts) {
          throw requestError;
        }
        lastError = requestError;
      } catch (error) {
        if (
          error instanceof GmailApiRequestError &&
          (!isRetryableStatus(error.status) || attempt === attempts)
        ) {
          throw error;
        }
        lastError = error;
        if (attempt === attempts) {
          throw new GmailApiRequestError(null, "GMAIL_NETWORK_ERROR");
        }
      } finally {
        clearTimeout(timeout);
      }
      await (this.options.wait ?? wait)(
        retryDelay(attempt, this.options.random ?? Math.random)
      );
    }
    throw lastError instanceof Error
      ? lastError
      : new GmailApiRequestError(null, "GMAIL_NETWORK_ERROR");
  }
}

function parseHistoryRecord(value: unknown): GmailHistoryRecord {
  const record = readRecord(value);
  const id = readHistoryId(record?.id);
  if (!record || !id) {
    throw new GmailApiRequestError(null, "GMAIL_HISTORY_RESPONSE_INVALID");
  }
  const rawAdded = Array.isArray(record.messagesAdded)
    ? record.messagesAdded
    : [];
  const messagesAdded = rawAdded.map((entry) => {
    const message = readRecord(readRecord(entry)?.message);
    const messageId = message?.id;
    if (!message || typeof messageId !== "string") {
      throw new GmailApiRequestError(null, "GMAIL_HISTORY_RESPONSE_INVALID");
    }
    assertGmailIdentifier(messageId);
    return {
      message: {
        id: messageId,
        labelIds: readStringArray(message.labelIds, 100)
      }
    };
  });
  return { id, messagesAdded };
}

function parseMessage(value: unknown): GmailMessage {
  const record = readRecord(value);
  const id = record?.id;
  if (!record || typeof id !== "string") {
    throw new GmailApiRequestError(null, "GMAIL_MESSAGE_RESPONSE_INVALID");
  }
  assertGmailIdentifier(id);
  return {
    id,
    internalDate: readDecimalString(record.internalDate),
    labelIds: readStringArray(record.labelIds, 100),
    snippet: readOptionalBoundedString(record.snippet, 20_000) ?? "",
    payload: parseMessagePart(record.payload, 0)
  };
}

function parseMessagePart(value: unknown, depth: number): GmailMessagePart {
  if (depth > 30) {
    throw new GmailApiRequestError(null, "GMAIL_MIME_NESTING_LIMIT");
  }
  const record = readRecord(value);
  if (!record) {
    throw new GmailApiRequestError(null, "GMAIL_MESSAGE_RESPONSE_INVALID");
  }
  const body = readRecord(record.body);
  const headers = Array.isArray(record.headers) ? record.headers : [];
  const parts = Array.isArray(record.parts) ? record.parts : [];
  return {
    mimeType: readOptionalBoundedString(record.mimeType, 255) ?? "",
    filename: readOptionalBoundedString(record.filename, 1024) ?? "",
    headers: headers.map((header) => {
      const parsed = readRecord(header);
      return {
        name: readOptionalBoundedString(parsed?.name, 255) ?? "",
        value: readOptionalBoundedString(parsed?.value, 32_768) ?? ""
      };
    }),
    body: {
      size:
        typeof body?.size === "number" && Number.isSafeInteger(body.size)
          ? body.size
          : 0,
      data: readOptionalBoundedString(body?.data, 2_000_000),
      attachmentId: readOptionalBoundedString(body?.attachmentId, 2048)
    },
    parts: parts.map((part) => parseMessagePart(part, depth + 1))
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readHistoryId(value: unknown): string | null {
  const id = readDecimalString(value);
  return id && id.length <= 64 ? id.replace(/^0+(?=\d)/u, "") : null;
}

function readDecimalString(value: unknown): string | null {
  return typeof value === "string" && /^\d+$/u.test(value) ? value : null;
}

function readOptionalBoundedString(
  value: unknown,
  maximumLength: number
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new GmailApiRequestError(null, "GMAIL_RESPONSE_INVALID");
  }
  return value;
}

function readStringArray(value: unknown, maximumItems: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new GmailApiRequestError(null, "GMAIL_RESPONSE_INVALID");
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.length > 255) {
      throw new GmailApiRequestError(null, "GMAIL_RESPONSE_INVALID");
    }
    return entry;
  });
}

function assertGmailIdentifier(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,191}$/u.test(value)) {
    throw new GmailApiRequestError(null, "GMAIL_IDENTIFIER_INVALID");
  }
}

function isRetryableStatus(status: number | null): boolean {
  return status === 429 || (status !== null && status >= 500);
}

function retryDelay(attempt: number, random: () => number): number {
  return Math.min(250 * 2 ** (attempt - 1), 2_000) + Math.floor(random() * 100);
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
