# Algorithms — implementation contracts, not runnable provider clients

## 1. Discover and claim

The same helper is used by push-triggered delta, scheduled delta, and reconciliation.
`MailAuthorization.id` is used as stable mailboxId only after verified provider-subject
mapping has been checked. Never use message header Message-ID as the deduplication key.

```ts
identity = identityFromTrustedConnection(connection, exactProviderMessageId)
key = messageKey(identity)
transaction {
  INSERT MailMessageLedger(identity, key) ON CONFLICT(messageKey) DO NOTHING
  ledger = SELECT ... WHERE messageKey=key
  assertSameIdentity(ledger, identity) // collision or tenant mismatch => stop + incident
  INSERT MailEvaluation(messageId, lane, connectionId, immutableRuleSnapshot)
    ON CONFLICT(messageId,lane) DO NOTHING
  // During worker phase only; PR 01 stays synchronous through the old path.
  INSERT ReliabilityJob(kind=EVALUATE, dedupeKey=H(lane,evaluation.id), identifiersOnly)
    ON CONFLICT(dedupeKey) DO NOTHING
}
```

Terminal decisions are not reset by redelivery. An operator retry of UNDETERMINED
reopens the existing evaluation and its job in a fenced transaction; it does not
create an additional logical Alert. Rule snapshots are not replaced by current rules.

## 2. Shared transaction for evaluation / Alert / recipients / Outbox

The current PrismaAlertRepository.ingest starts its own SERIALIZABLE transaction.
Extract its transaction body into `ingestWithinTransaction(tx, input)`. Keep the old
public method as a wrapper around the extracted body. Calling the old ingest inside
another transaction is NOT an atomic implementation.

```ts
fetched = await provider.getMessage(id, token) // outside tx, bounded HTTP timeout
verdict = evaluate(fetched, savedRuleSnapshot)
retrySerializableTransaction(() => db.$transaction(async tx => {
  await lockMonitoringState(tx, connection.id)
  await assertIngestionOwnerAndGeneration(tx, expectedOwner, routeGeneration)
  await lockOwnedJob(tx, claim)
  await lockLedgerAndEvaluation(tx, message.id, evaluation.id)
  await assertTenantMailboxAndEligibility(tx, fetched.providerReceivedAt)

  if (lane === 'SHADOW') {
    await saveShadowVerdict(tx, verdict)
    await finishOwnedJob(tx, claim)
    return // strictly no Alert, recipient, outbox, SSE hint
  }

  if (verdict.kind === 'MATCHED') {
    // Reuse linked Alert; additionally link existing legacy raw-ID Alerts.
    // The old and new writers MUST obey the same routing fence before cutover.
    alert = await findLinkedOrLegacyAlert(tx, message)
    if (!alert) alert = await ingestWithinTransaction(tx, input)
    await linkMessageToAlert(tx, message.id, alert.id)
    recipients = await tx.alertRecipient.findMany({where: {alertId: alert.id}})
    for (r of recipients) {
      await upsertOutbox(tx, {
        eventKey: H('ALERT_AVAILABLE', alert.id, r.id, 'v1'),
        kind: 'ALERT_AVAILABLE', teamId, alertId: alert.id, recipientId: r.id,
        payload: {schemaVersion:1}
      })
    }
  }
  await saveFinalVerdict(tx, verdict)
  await finishOwnedJob(tx, claim)
}, {isolationLevel:'Serializable'}))
// Wake existing SSE readers only AFTER commit; this is an optional hint.
```

Current active authorization/team/subscription/recipient checks must not be lost.
Once desired/observed is authoritative, AUTH_REQUIRED must not close the monitoring
epoch; a fetch/job waits for reauthorization, then resumes. Actual user pause prevents
new delivery until resumed. A queued pre-pause eligible message is held, not silently
marked excluded. Messages received in a user-paused gap remain excluded after resume.
Revocation/disconnection and account deletion do not trigger unauthorized fetches.

Retries for P2034 / 40001 / 40P01 repeat this database-only transaction, not provider
HTTP calls. Preserve existing audit events. Put no token/mail text into outbox payloads.

## 3. Cursor separation and durable pages

A MailSyncStream has acquiredCursor/acquiredSeq and evaluatedSeq.
Provider cursors are opaque. Only database seq is an ordered local integer.

```ts
claim sync job
transaction {
  lock monitoring state, sync job, then sync stream
  resume its unfinished batch OR allocate seq=stream.nextSeq; nextSeq++
}
page = await provider.listChanges(batch.initialCursor, batch.pageCheckpoint)
transaction {
  assert same job lease, routing generation and expected pageNumber
  for each candidate in page:
    discover ledger + evaluation + evaluation job
    INSERT batch item(batchId,evaluationId) ON CONFLICT DO NOTHING
  persist returned nextPageToken and increment pageNumber
  if final page:
    mark enumerationFinishedAt
    save final provider cursor to stream.acquiredCursor
    set acquiredSeq=batch.seq
  complete job OR requeue the same run for the next page
}
```

Gmail: do not advance to the push hint or the maximum observed historyId on an
intermediate page. After the final page, commit the documented response historyId.
Microsoft: keep nextLink as pageCheckpoint; commit deltaLink only at end. Do not
lexicographically compare or arithmetically increment deltaLink.

The evaluational frontier advances only across consecutive enumerated batches whose
items are MATCHED/NOT_MATCHED/EXCLUDED. UNDETERMINED is an explicit unresolved hole.
Empty fully enumerated batches are valid. Batch 11 waiting on a broken mail prevents
"evaluated through 11", but does not prevent batch 12+ mail processing and notification.
This is a known-batch completion frontier, not proof all provider mail before a wall
clock timestamp existed in the snapshot. Independent reconciliation tracks coverage.

## 4. Independent reconciliation

Use messages.list / Graph list messages, NOT History/delta, for this path.
No server-side keyword filter, unread filter, or last max(receivedAt) optimization.

```ts
run = resumeOrCreateReconcileBatch(fixedFrom, fixedTo)
page = await provider.listInboxIds(run.range, run.pageCheckpoint)
transaction {
  assert job/page fences
  for each ID in page:
    find ledger by canonical key
    if absent => insert ledger and evaluation+job
    else if evaluation pending/undetermined => retain or schedule eligible retry
    attach evaluation to run even when ledger already existed
  persist pagination checkpoint
  if page enumeration complete => enumerationFinishedAt=now
}
when every item has an actual final decision:
  decisionsFinishedAt=now
  advance contiguous verifiedThrough (never skip a prior hole)
```

Use provider receive timestamps (Gmail internalDate / Graph receivedDateTime), not
mail Date headers. Query an overlap, then apply exact [start,end) predicates in code.
Use a complete backward sweep of all relevant monitoring epochs, split into durable
bounded tasks, not a permanent 24h/72h cutoff. Frequent sweeps: last 24h every 5min;
older ranges: cyclic/daily with a coverage ledger. API requests stay paginated.
Resource/time caps enqueue continuation, not "success". Snapshot changes, folder moves,
and complete deletion are limitations: record UNDETERMINED rather than claim coverage.

## 5. Expired cursor recovery

On Gmail History 404 or Graph cursor invalidation, preserve the old acquiredCursor
and the earliest unresolved coverage interval. Set RECOVERING. Do not set cursor=now.

Gmail baseline:
1. Get a current history anchor C0 BEFORE the inventory scan.
2. Fully inventory the relevant retained monitoring epochs, persisting tasks/pages.
3. Read all History changes after C0, persist all pages/tasks.
4. Commit the final history cursor only after those tasks are durable.
5. Keep RECOVERING while unresolved decisions or reconciliation gaps remain.

Graph baseline:
1. Start an unfiltered folder delta baseline with ImmutableId enabled.
2. Persist all pages/tasks and apply monitoring epochs in application code.
3. Store only the final deltaLink as the acquired cursor.
4. Follow with incremental sync and independent list reconciliation.
Do not use the receivedDateTime filter as the complete baseline: Microsoft documents
an upper bound of 5,000 returned messages for a filtered message delta query.

## 6. OAuth refresh with fencing

```ts
transaction {
  lock MailAuthorization
  if valid cached access token with >5min TTL and not forceRefresh: return token
  if refreshLeaseUntil > dbNow: return BUSY(retryAfter)
  reserve refreshLeaseToken, increment refreshLeaseGeneration
  capture credentialVersion and encrypted refresh token
}
result = await provider.refresh(decrypt(refreshToken), timeout=10s)
encrypted = await encrypt(result.accessToken, result.newRefreshTokenIfAny)
transaction {
  UPDATE MailAuthorization
  SET encryptedAccessToken=..., accessTokenExpiresAt=...,
      encryptedRefreshToken=COALESCE(newRefreshToken,oldRefreshToken),
      credentialVersion=credentialVersion+1,
      refreshLeaseToken=NULL, refreshLeaseUntil=NULL
  WHERE id=... AND credentialVersion=captured
    AND refreshLeaseToken=ours AND refreshLeaseGeneration=capturedLeaseGeneration
    AND refreshLeaseUntil > dbNow
  if affected != 1: discard result; use fresh DB state, never overwrite
}
```

All reauth/revocation writers increment credentialVersion. Late invalid_grant/401
results also check version/lease before changing status: an old failure must not
invalidate a newer successful login. A 401 on message fetch permits one forced
refresh+replay; don't retry indefinitely. Distinguish 403 quota/configuration/consent.

A token-provider call and PostgreSQL cannot commit atomically. A process may lose a
rotated token response. Reuse a still-valid prior token where the provider permits it;
otherwise preserve jobs and explicitly require reauthorization. No "guaranteed
automatic recovery" claim for revoked authorization.

## 7. Registration maintenance

ProviderRegistration is per mailbox+scope, not per Team. Preserve existing active
Google-per-Team constraints. Do not call Gmail users.stop while ANY authorized Team
connection still desires RUNNING for that mailbox. Renewals do not reset cursors or
epochs. Initial/explicit resume establishes a new epoch; OAuth recovery does not.

Scheduler checks due rows every minute. First renewal failure creates/upserts an
incident and an operator outbox immediately; poll continues. Advance renewAfter
only on accepted renewal persistence. Use actual returned expiration with safety
margin. Recreate expired Graph registration, process missed/subscriptionRemoved/
reauthorizationRequired as resync triggers, and record any unknown gap.
Remote creation timeout may leave an orphan subscription: reconcile actual registered
subscriptions before creating repeatedly; clean only app-owned stale registrations.

## 8. Outbox and APNs boundary

Current core consumer: durable IN_APP availability (existing AlertRecipient rows),
SSE wake hint, and operator/status events. PostgreSQL polling remains authoritative;
LISTEN/NOTIFY or a process-local callback is not itself durable delivery.

APNs is not implemented in this core rollout. A transport interface and a fake can
be tested, but no row is marked APNS_ACCEPTED unless a real APNs call returned success.
If mobile delivery is requested but no endpoint/credentials exist, record BLOCKED or
WAITING_CONFIGURATION, open an incident, and retain the work.

Future dispatcher-to-APNs integration must persist one delivery row per logical
outbox event + target + target token version, then mark outbox dispatched in the same
transaction. APNs sends occur outside it. Success=provider acceptance, not user read.
Ambiguous response+retry may duplicate external presentation; keep Alert logical ID
stable and do not promise exactly-once APNs appearance. Do not refan-out old Alerts
merely because an outbox migration ran.

## 9. Synthetic monitor

Create SyntheticRun before sending, unique by (probeId,scheduledFor). Put its UUID
in the approved synthetic subject/body. Use a dedicated sender and test mailbox/Team.
Mail must pass through the REAL provider detection/matching/fan-out/outbox path.
Correlate the marker only for configured synthetic mailboxes; never special-case the
matcher into success. This is not the user's TEST Alert API.

Sending has an ambiguous-success window too: use sender idempotency when supported;
otherwise mark SEND_UNKNOWN and look for the marker before retrying. No infinite send.
A missed scheduled run is a failure even when no SyntheticRun row was created.

Until APNs is implemented, PASSED means send+detect+Alert+recipients+Outbox, not iPhone
receipt or sound. Record push/poll/reconciliation observations separately so fallback
success cannot hide a failed push channel.

## 10. Health response

Compute from desired state, token health, independently refreshed worker heartbeats,
sync freshness, unresolved decisions and outbox backlog. Do not echo ACTIVE as HEALTHY.
Return validUntil, lastSuccessfulSyncAt, pendingCount, undeterminedCount, recoveryFrom,
lastReconcileAt, pushStatus, safeReasonCodes. UI expires its cached green state using
elapsed monotonic time based on the server's TTL, not a possibly skewed wall clock.
No successful empty sync may clear an unrelated unresolved incident.
