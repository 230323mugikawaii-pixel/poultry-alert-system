// PSEUDOCODE — adapt named functions to the existing GmailMonitoringService.
// No new polling, registration renewal, APNs, or secondary notification producer.

async function processMessageWithLedger(connection, providerMessageId) {
  if (ledgerMode === 'off') return existingProcessMessage(connection, providerMessageId);

  // Resolve from trusted connection + authorization, never caller-supplied tenant data.
  const entry = await discoverAndCreateEvaluation({
    teamId: connection.teamId,
    provider: connection.provider,
    mailboxId: connection.authorizationId, // stable on reauthorization
    connectionId: connection.id,
    providerMessageId,
    lane: 'LEGACY',
    keywordsSnapshot: connection.keywords,
    matcherVersion: 'existing-matcher-v1',
  });
  // discover uses INSERT ... ON CONFLICT DO NOTHING, then reads/verifies raw identity.
  // It NEVER resets a prior MATCHED/NOT_MATCHED/EXCLUDED decision.

  if (isFinalDecision(entry.evaluation)) return;

  await markFetchPending(entry.evaluation.id);
  try {
    // HTTP/API calls are outside a database transaction.
    const message = await existingFetchMessage(connection, providerMessageId);
    await recordReceivedAtAndMarkEvaluating(entry, message.internalDate);

    // Initially preserve current eligibility and matcher semantics EXACTLY.
    // Snapshot the actual rules passed to the matcher. Do not broaden folders.
    const verdict = existingEligibilityAndMatcher(message, entry.evaluation.keywordsSnapshot);
    if (verdict.kind === 'EXCLUDED') {
      await recordFinalDecision(entry, 'EXCLUDED', verdict.reason);
      return;
    }
    if (verdict.kind === 'NOT_MATCHED') {
      await recordFinalDecision(entry, 'NOT_MATCHED');
      return;
    }

    // The OLD path is the only notification writer in PR 01.
    // It already deduplicates (sourceMailConnectionId, sourceEventId).
    const result = await existingAlertService.ingest({
      teamId: connection.teamId,
      sourceMailConnectionId: connection.id,
      sourceEventId: providerMessageId,
      matchedKeyword: verdict.keyword,
      kind: 'REAL',
      detectedAt: now(),
    });
    // If a crash occurred between Alert commit and this call, redelivery finds
    // the existing Alert and completes the ledger. It must NOT refan-out.
    await linkExistingAlertAndRecordMatched(entry, result.alert.id, verdict.keyword);
  } catch (error) {
    if (isConfirmedMessageGet404(error) || isUnsupportedOrUnparseable(error)) {
      await recordUndetermined(entry, safeErrorCode(error));
      // This is not a successful keyword decision. Emit a structured warning;
      // a later incident/dashboard PR surfaces persistent unresolved rows.
      return;
    }
    await recordPendingFailure(entry, safeErrorCode(error));
    throw error; // Keep old webhook retry behavior. Never ACK a failed ledger write.
  }
}

// PR 01 deliberately does not make ledger + Alert atomic yet.
// PR 02 extracts ingestWithinTransaction and commits verdict+Alert+recipients+Outbox
// in one DB transaction. Do not claim the whole five-feature plan is complete in PR 01.
