import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  connect,
  createServer,
  type IncomingHttpHeaders,
  type ServerHttp2Session,
  type ServerHttp2Stream
} from "node:http2";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { readApnsConfiguration } from "../../src/modules/device-push/apns-config.js";
import { encryption, makeDeviceToken } from "./device-push-harness.js";
import { pushIdempotencyKey } from "../../src/modules/device-push/push-transport.js";

// Synthetic ephemeral key/token, never written to the repo or output.
export const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
export const apnsEnvironment = () => ({
  APP_ENV: "test",
  APNS_ENVIRONMENT: "sandbox",
  APNS_TEAM_ID: "SYNTHETIC1",
  APNS_KEY_ID: "SYNTHETIC2",
  APNS_BUNDLE_ID: "example.callnow.test",
  APNS_PRIVATE_KEY: keys.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString()
});
export const apnsConfiguration = () => readApnsConfiguration(apnsEnvironment());
export async function apnsInput() {
  const token = makeDeviceToken();
  return {
    token,
    input: {
      deliveryId: randomUUID(),
      alertId: randomUUID(),
      recipientId: randomUUID(),
      endpointKey: randomUUID(),
      endpointVersion: 1,
      attemptId: randomUUID(),
      idempotencyKey: pushIdempotencyKey(randomUUID(), randomUUID(), 1),
      encryptedToken: JSON.stringify(await encryption.encrypt(token)),
      confirmCurrent: async () => true
    }
  };
}
export interface MockRequest {
  headers: IncomingHttpHeaders;
  body: string;
}
export async function startApnsMock(
  handler: (stream: ServerHttp2Stream, request: MockRequest) => void = (
    s,
    r
  ) => {
    s.respond({ ":status": 200, "apns-id": r.headers["apns-id"] });
    s.end();
  }
) {
  const requests: MockRequest[] = [],
    sessions = new Set<ServerHttp2Session>();
  const server = createServer();
  let connections = 0;
  server.on("session", (session) => {
    sessions.add(session);
    connections++;
    session.on("error", () => {});
    session.on("close", () => sessions.delete(session));
  });
  server.on("stream", (stream: ServerHttp2Stream, headers) => {
    stream.on("error", () => {});
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      body += String(chunk);
    });
    stream.on("end", () => {
      const r = { headers, body };
      requests.push(r);
      handler(stream, r);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    requests,
    get connections() {
      return connections;
    },
    connect: () => connect(`http://127.0.0.1:${port}`),
    close: async () => {
      for (const s of sessions) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  };
}
