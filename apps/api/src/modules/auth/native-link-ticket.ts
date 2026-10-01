import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
  ConsumeNativeLinkTicketInput,
  NativeLinkTicket
} from "./auth-repository.js";

const Provider = Type.Union([
  Type.Literal("GOOGLE"),
  Type.Literal("MICROSOFT")
]);
const TicketPayload = Type.Object({
  nativeLinkTicket: Type.Literal(1),
  provider: Provider,
  sessionId: Type.String({ pattern: "^[a-fA-F0-9-]{36}$" }),
  codeChallenge: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
  stage: Type.Union([
    Type.Literal("HANDOFF"),
    Type.Literal("CALLBACK"),
    Type.Literal("FINALIZE")
  ]),
  identity: Type.Optional(
    Type.Object({
      provider: Provider,
      providerSubject: Type.String({ minLength: 1, maxLength: 255 }),
      email: Type.Union([Type.String({ maxLength: 320 }), Type.Null()]),
      displayName: Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
      emailVerified: Type.Boolean()
    })
  )
});

export function readNativeLinkTicket(
  payload: unknown,
  userId: string | null
): NativeLinkTicket | null {
  if (!userId || !Value.Check(TicketPayload, payload)) return null;
  if (
    payload.stage === "FINALIZE" &&
    (!payload.identity || payload.identity.provider !== payload.provider)
  )
    return null;
  return { ...payload, userId };
}

export function matchesNativeLinkTicket(
  ticket: NativeLinkTicket,
  input: ConsumeNativeLinkTicketInput
): boolean {
  if (ticket.stage !== input.stage || ticket.provider !== input.provider)
    return false;
  // FINALIZE can never be consumed without all three bindings, including S256.
  if (input.stage === "FINALIZE" && !input.binding) return false;
  return (
    !input.binding ||
    (ticket.userId === input.binding.userId &&
      ticket.sessionId === input.binding.sessionId &&
      ticket.codeChallenge === input.binding.codeChallenge)
  );
}
