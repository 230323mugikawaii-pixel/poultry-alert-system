import { createHmac, randomBytes } from "node:crypto";
import argon2 from "argon2";

const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1
} as const;

export interface PreparedInvitationCredential {
  readonly password: string;
  readonly passwordHash: string;
  readonly expiresAt: Date;
}

export async function prepareInvitationCredential(input: {
  readonly now: Date;
  readonly ttlDays: number;
  readonly password?: string;
}): Promise<PreparedInvitationCredential> {
  const password = input.password ?? generateInvitationPassword();
  return {
    password,
    passwordHash: await hashInvitationPassword(password),
    expiresAt: addDays(input.now, input.ttlDays)
  };
}

export function derivePaidInvitationPassword(input: {
  readonly tokenPepper: string;
  readonly changeId: string;
  readonly paymentEventId: string;
}): string {
  return createHmac("sha256", input.tokenPepper)
    .update("paid-seat-increase\0", "utf8")
    .update(input.changeId, "utf8")
    .update("\0", "utf8")
    .update(input.paymentEventId, "utf8")
    .digest("base64url");
}

export function generateInvitationPassword(): string {
  return randomBytes(18).toString("base64url");
}

export function hashInvitationPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON_OPTIONS);
}

export function verifyInvitationPassword(
  passwordHash: string,
  password: string
): Promise<boolean> {
  return argon2.verify(passwordHash, password).catch(() => false);
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}
