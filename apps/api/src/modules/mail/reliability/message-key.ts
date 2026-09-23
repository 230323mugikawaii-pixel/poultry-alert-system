import { createHash } from "node:crypto";

export interface MessageIdentity {
  readonly teamId: string;
  readonly provider: "GOOGLE" | "MICROSOFT";
  readonly mailboxId: string;
  readonly providerMessageId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function canonicalMessageIdentity(
  input: MessageIdentity
): readonly string[] {
  if (!UUID.test(input.teamId) || !UUID.test(input.mailboxId)) {
    throw new Error("INVALID_INTERNAL_ID");
  }
  if (input.provider !== "GOOGLE" && input.provider !== "MICROSOFT") {
    throw new Error("INVALID_PROVIDER");
  }
  if (
    !input.providerMessageId ||
    Array.from(input.providerMessageId).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new Error("INVALID_PROVIDER_MESSAGE_ID");
  }
  return [
    "mail-v1",
    input.teamId.toLowerCase(),
    input.provider,
    input.mailboxId.toLowerCase(),
    input.providerMessageId
  ];
}

export function messageKey(input: MessageIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalMessageIdentity(input)), "utf8")
    .digest("hex");
}

export function assertSameIdentity(
  stored: MessageIdentity,
  incoming: MessageIdentity
): void {
  if (
    JSON.stringify(canonicalMessageIdentity(stored)) !==
    JSON.stringify(canonicalMessageIdentity(incoming))
  ) {
    throw new Error("MESSAGE_KEY_COLLISION_OR_IDENTITY_MISMATCH");
  }
}

// No Microsoft ingress is enabled by this helper. Existing Gmail IDs stay raw.
export function sourceEventId(input: MessageIdentity): string {
  const key = messageKey(input);
  return input.provider === "GOOGLE" ? input.providerMessageId : `m1:${key}`;
}
