"use strict";

(function initializeAlertTabCoordination(root, factory) {
  const alertTabCoordination = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = alertTabCoordination;
  }

  if (root) {
    root.CallNowAlertTabCoordination = alertTabCoordination;
  }
})(
  typeof globalThis === "object" ? globalThis : this,
  function createAlertTabCoordination() {
    const STATE_VERSION = 1;
    const STATE_KEY = "callNowAlertPresentationStateV1";
    const CHANNEL_NAME = "call-now-alert-presentation";
    const CANDIDATE_PREFIX = "callNowAlertPresentationCandidateV1:";
    const MAX_HANDLED_ALERTS = 5000;
    const CANDIDATE_TTL_MS = 5000;
    const DEFAULT_ELECTION_DELAY_MS = 80;
    const HANDLED_STATES = new Set(["PRESENTED", "SILENT", "STOPPED"]);

    function validAlertId(value) {
      return typeof value === "string" && value.length > 0 && value.length <= 200;
    }

    function validHandledState(value) {
      return HANDLED_STATES.has(value);
    }

    function createTabId(randomUuid, now, random) {
      if (typeof randomUuid === "function") {
        try {
          const value = randomUuid();
          if (typeof value === "string" && value) return value;
        } catch {
          /* 安全なフォールバックIDを使用する。 */
        }
      }
      return `${now().toString(36)}-${Math.floor(random() * 1e12).toString(36)}`;
    }

    function parseState(value) {
      if (!value) return new Map();
      try {
        const parsed = JSON.parse(value);
        if (parsed?.version !== STATE_VERSION || !Array.isArray(parsed.alerts)) {
          return new Map();
        }
        const records = new Map();
        parsed.alerts.forEach((record) => {
          if (
            validAlertId(record?.id) &&
            validHandledState(record?.state) &&
            Number.isFinite(record?.updatedAt)
          ) {
            records.set(record.id, {
              id: record.id,
              state: record.state,
              updatedAt: record.updatedAt,
            });
          }
        });
        return records;
      } catch {
        return new Map();
      }
    }

    function serializeState(records) {
      const alerts = Array.from(records.values())
        .sort((left, right) => left.updatedAt - right.updatedAt)
        .slice(-MAX_HANDLED_ALERTS);
      return JSON.stringify({ version: STATE_VERSION, alerts });
    }

    function shouldPresentAlert(alert, pageStartedAt) {
      if (!alert || alert.status !== "ACTIVE" || alert.readAt || alert.dismissedAt) {
        return false;
      }
      if (alert.kind !== "TEST") return true;
      const detectedAt = Date.parse(alert.detectedAt || "");
      return Number.isFinite(detectedAt) && detectedAt >= pageStartedAt;
    }

    function createCoordinator(options = {}) {
      const storage = options.storage || null;
      const lockManager = options.lockManager || null;
      const now = options.now || Date.now;
      const random = options.random || Math.random;
      const wait =
        options.wait ||
        ((milliseconds) =>
          new Promise((resolve) => setTimeout(resolve, milliseconds)));
      const electionDelayMs =
        options.electionDelayMs ?? DEFAULT_ELECTION_DELAY_MS;
      const tabId =
        options.tabId ||
        createTabId(options.randomUuid, now, random);
      const subscribers = new Set();
      const candidates = new Map();
      let records = new Map();
      let channel = null;
      let removeStorageListener = null;

      function readStorageState() {
        if (!storage) return new Map();
        try {
          return parseState(storage.getItem(STATE_KEY));
        } catch {
          return new Map();
        }
      }

      function mergeRecord(record, notify) {
        if (
          !validAlertId(record?.id) ||
          !validHandledState(record?.state) ||
          !Number.isFinite(record?.updatedAt)
        ) {
          return false;
        }
        const existing = records.get(record.id);
        if (
          existing &&
          (existing.updatedAt > record.updatedAt ||
            (existing.updatedAt === record.updatedAt &&
              existing.state === record.state))
        ) {
          return false;
        }
        records.set(record.id, { ...record });
        if (notify) {
          subscribers.forEach((subscriber) => {
            subscriber({ ...record });
          });
        }
        return true;
      }

      function refreshFromStorage(notify = false) {
        readStorageState().forEach((record) => {
          mergeRecord(record, notify);
        });
      }

      function persistRecords() {
        if (!storage) return false;
        try {
          storage.setItem(STATE_KEY, serializeState(records));
          return true;
        } catch {
          return false;
        }
      }

      function broadcast(message) {
        try {
          channel?.postMessage(message);
        } catch {
          /* localStorage同期をフォールバックとして使用する。 */
        }
      }

      function setHandled(alertId, state, shouldBroadcast = true) {
        if (!validAlertId(alertId) || !validHandledState(state)) return null;
        refreshFromStorage(false);
        const record = { id: alertId, state, updatedAt: now() };
        const existing = records.get(alertId);
        if (existing?.state === "STOPPED" && state !== "STOPPED") {
          return existing;
        }
        records.set(alertId, record);
        persistRecords();
        if (shouldBroadcast) {
          broadcast({
            type: "ALERT_HANDLED",
            record,
            senderTabId: tabId,
          });
        }
        return record;
      }

      function hasHandled(alertId) {
        refreshFromStorage(false);
        return records.has(alertId);
      }

      function handledAlertIds() {
        refreshFromStorage(false);
        return Array.from(records.keys());
      }

      function candidateKey(alertId, candidateTabId) {
        return `${CANDIDATE_PREFIX}${encodeURIComponent(alertId)}:${candidateTabId}`;
      }

      function writeCandidate(candidate) {
        candidates.set(candidate.tabId, candidate);
        if (storage) {
          try {
            storage.setItem(
              candidateKey(candidate.alertId, candidate.tabId),
              JSON.stringify(candidate),
            );
          } catch {
            /* BroadcastChannel候補選定へフォールバックする。 */
          }
        }
        broadcast({ type: "ALERT_CANDIDATE", candidate });
      }

      function removeCandidate(candidate) {
        candidates.delete(candidate.tabId);
        if (!storage) return;
        try {
          storage.removeItem(candidateKey(candidate.alertId, candidate.tabId));
        } catch {
          /* 期限切れ候補として後続処理が無視する。 */
        }
      }

      function readCandidates(alertId) {
        const cutoff = now() - CANDIDATE_TTL_MS;
        const found = new Map();
        candidates.forEach((candidate) => {
          if (candidate.alertId === alertId && candidate.startedAt >= cutoff) {
            found.set(candidate.tabId, candidate);
          }
        });
        if (storage) {
          try {
            for (let index = 0; index < storage.length; index += 1) {
              const key = storage.key(index);
              if (!key?.startsWith(CANDIDATE_PREFIX)) continue;
              const candidate = JSON.parse(storage.getItem(key) || "null");
              if (
                candidate?.alertId === alertId &&
                typeof candidate.tabId === "string" &&
                Number.isFinite(candidate.startedAt) &&
                candidate.startedAt >= cutoff
              ) {
                found.set(candidate.tabId, candidate);
              }
            }
          } catch {
            /* 読み取れた候補だけで選定する。 */
          }
        }
        return Array.from(found.values()).sort(
          (left, right) =>
            left.startedAt - right.startedAt ||
            left.tabId.localeCompare(right.tabId),
        );
      }

      async function claimWithFallback(alertId) {
        const candidate = { alertId, tabId, startedAt: now() };
        writeCandidate(candidate);
        try {
          await wait(electionDelayMs);
          if (hasHandled(alertId)) return false;
          const winner = readCandidates(alertId)[0];
          if (!winner || winner.tabId !== tabId) return false;
          if (hasHandled(alertId)) return false;
          setHandled(alertId, "PRESENTED");
          return true;
        } finally {
          removeCandidate(candidate);
        }
      }

      async function claimPresentation(alertId) {
        if (!validAlertId(alertId) || hasHandled(alertId)) return false;
        if (typeof lockManager?.request === "function") {
          try {
            return await lockManager.request(
              `call-now-alert:${alertId}`,
              { mode: "exclusive" },
              () => {
                if (hasHandled(alertId)) return false;
                setHandled(alertId, "PRESENTED");
                return true;
              },
            );
          } catch {
            return claimWithFallback(alertId);
          }
        }
        return claimWithFallback(alertId);
      }

      function applyExternalRecord(record) {
        if (!mergeRecord(record, true)) return;
        persistRecords();
      }

      function handleChannelMessage(event) {
        const message = event?.data;
        if (message?.senderTabId === tabId) return;
        if (message?.type === "ALERT_CANDIDATE") {
          const candidate = message.candidate;
          if (
            validAlertId(candidate?.alertId) &&
            typeof candidate?.tabId === "string" &&
            Number.isFinite(candidate?.startedAt)
          ) {
            candidates.set(candidate.tabId, candidate);
          }
          return;
        }
        if (message?.type === "ALERT_HANDLED") {
          applyExternalRecord(message.record);
        }
      }

      records = readStorageState();

      if (typeof options.createChannel === "function") {
        try {
          channel = options.createChannel(CHANNEL_NAME);
          channel?.addEventListener?.("message", handleChannelMessage);
        } catch {
          channel = null;
        }
      }

      if (typeof options.addStorageListener === "function") {
        const listener = (event) => {
          if (event?.key === STATE_KEY) refreshFromStorage(true);
        };
        options.addStorageListener(listener);
        removeStorageListener = () => {
          options.removeStorageListener?.(listener);
        };
      }

      return {
        claimPresentation,
        dispose() {
          removeStorageListener?.();
          channel?.removeEventListener?.("message", handleChannelMessage);
          channel?.close?.();
          subscribers.clear();
        },
        handledAlertIds,
        hasHandled,
        markHandled(alertId, state = "PRESENTED") {
          return setHandled(alertId, state);
        },
        stop(alertId) {
          return setHandled(alertId, "STOPPED");
        },
        subscribe(subscriber) {
          subscribers.add(subscriber);
          return () => subscribers.delete(subscriber);
        },
        tabId,
      };
    }

    return {
      CHANNEL_NAME,
      STATE_KEY,
      createCoordinator,
      parseState,
      shouldPresentAlert,
    };
  },
);
