import test from 'node:test';
import assert from 'node:assert/strict';
import { messageKey, assertSameIdentity } from '../step-01/message-key.ts';

const base = {
  teamId: '10000000-0000-4000-8000-000000000001',
  provider: 'GOOGLE',
  mailboxId: '20000000-0000-4000-8000-000000000002',
  providerMessageId: '18aBcD',
};
test('same identity has same key', () => assert.equal(messageKey(base), messageKey({...base})));
test('team is part of identity', () => assert.notEqual(messageKey(base), messageKey({...base, teamId: '10000000-0000-4000-8000-000000000009'})));
test('provider is part of identity', () => assert.notEqual(messageKey(base), messageKey({...base, provider: 'MICROSOFT'})));
test('mailbox is part of identity', () => assert.notEqual(messageKey(base), messageKey({...base, mailboxId: '20000000-0000-4000-8000-000000000009'})));
test('provider ID case is preserved', () => assert.notEqual(messageKey(base), messageKey({...base, providerMessageId: '18abcd'})));
test('long IDs are not silently truncated to 191 characters', () => {
  const prefix = 'x'.repeat(400);
  assert.notEqual(messageKey({...base, providerMessageId: prefix+'a'}), messageKey({...base, providerMessageId: prefix+'b'}));
});
test('mismatching raw identity is rejected', () => assert.throws(() => assertSameIdentity(base, {...base, providerMessageId: 'another'})));
test('control characters are rejected', () => assert.throws(() => messageKey({...base, providerMessageId: 'a\nb'})));
