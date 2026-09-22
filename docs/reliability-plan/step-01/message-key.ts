import { createHash } from 'node:crypto';

export type MailProvider = 'GOOGLE' | 'MICROSOFT';

export interface MessageIdentity {
  readonly teamId: string;
  readonly provider: MailProvider;
  readonly mailboxId: string;
  readonly providerMessageId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function canonicalMessageIdentity(input: MessageIdentity): readonly string[] {
  if (!UUID.test(input.teamId) || !UUID.test(input.mailboxId)) {
    throw new Error('INVALID_INTERNAL_ID');
  }
  if (input.provider !== 'GOOGLE' && input.provider !== 'MICROSOFT') {
    throw new Error('INVALID_PROVIDER');
  }
  if (!input.providerMessageId || /[\u0000-\u001f\u007f]/u.test(input.providerMessageId)) {
    throw new Error('INVALID_PROVIDER_MESSAGE_ID');
  }
  // Do NOT trim, lowercase or Unicode-normalize providerMessageId.
  return ['mail-v1', input.teamId.toLowerCase(), input.provider,
    input.mailboxId.toLowerCase(), input.providerMessageId];
}

export function messageKey(input: MessageIdentity): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalMessageIdentity(input)), 'utf8')
    .digest('hex');
}

// Call after an upsert hit. A hash collision must not become "already processed".
export function assertSameIdentity(stored: MessageIdentity, incoming: MessageIdentity): void {
  if (JSON.stringify(canonicalMessageIdentity(stored)) !==
      JSON.stringify(canonicalMessageIdentity(incoming))) {
    throw new Error('MESSAGE_KEY_COLLISION_OR_IDENTITY_MISMATCH');
  }
}
