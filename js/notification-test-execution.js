"use strict";

(function initializeNotificationTestExecution(root, factory) {
  const execution = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = execution;
  }

  if (root) {
    root.CallNowNotificationTestExecution = execution;
  }
})(
  typeof globalThis === "object" ? globalThis : this,
  function createNotificationTestExecution() {
    const RUNNING_PHASES = new Set([
      "STARTING",
      "REQUESTING_DELIVERY",
      "WAITING_DETECTION",
      "CREATING_ALERT",
      "WAITING_NOTIFICATION",
    ]);

    function initialState() {
      return {
        phase: "IDLE",
        keyword: null,
        testId: null,
        requestId: null,
        alertId: null,
        message: "",
        error: "",
        retryAt: null,
        retryDeadlineAt: null,
        rateLimit: null,
        audioStatus: null,
      };
    }

    function createController({ now = Date.now, onChange = () => {} } = {}) {
      let state = Object.freeze(initialState());
      let sequence = 0;
      let activeToken = null;

      function publish(nextState) {
        state = Object.freeze(nextState);
        onChange(state);
        return state;
      }

      function getView() {
        const remainingSeconds = state.retryDeadlineAt
          ? Math.max(0, Math.ceil((state.retryDeadlineAt - now()) / 1000))
          : 0;
        return {
          ...state,
          running: RUNNING_PHASES.has(state.phase),
          blocked:
            RUNNING_PHASES.has(state.phase) ||
            (state.phase === "RATE_LIMITED" && remainingSeconds > 0),
          remainingSeconds,
        };
      }

      function begin(keyword, phase = "STARTING") {
        if (getView().blocked) return null;
        sequence += 1;
        activeToken = sequence;
        publish({
          ...initialState(),
          phase,
          keyword,
        });
        return activeToken;
      }

      function transition(token, phase, patch = {}) {
        if (token !== activeToken) return false;
        publish({
          ...state,
          ...patch,
          phase,
        });
        return true;
      }

      function complete(token, patch = {}) {
        if (token !== activeToken) return false;
        activeToken = null;
        publish({
          ...state,
          ...patch,
          phase: "COMPLETE",
          error: "",
        });
        return true;
      }

      function fail(token, patch = {}) {
        if (token !== activeToken) return false;
        activeToken = null;
        publish({
          ...state,
          ...patch,
          phase: "ERROR",
          message: "",
        });
        return true;
      }

      function rateLimit(
        token,
        {
          retryAt = null,
          retryAfterSeconds = 0,
          rateLimit = null,
          error = "",
        } = {},
      ) {
        if (token !== activeToken) return false;
        activeToken = null;
        const seconds = Number.isFinite(retryAfterSeconds)
          ? Math.max(0, Math.ceil(retryAfterSeconds))
          : 0;
        publish({
          ...state,
          phase: "RATE_LIMITED",
          message: "",
          error,
          retryAt,
          retryDeadlineAt: seconds > 0 ? now() + seconds * 1000 : null,
          rateLimit,
        });
        return true;
      }

      function refreshRateLimit() {
        const view = getView();
        if (state.phase !== "RATE_LIMITED" || view.remainingSeconds > 0) {
          return false;
        }
        publish({
          ...initialState(),
          phase: "IDLE",
          message: "通知テストを再実行できます。",
        });
        return true;
      }

      function reset() {
        sequence += 1;
        activeToken = null;
        publish(initialState());
      }

      return {
        begin,
        complete,
        fail,
        getState: () => state,
        getView,
        isCurrent: (token) => token === activeToken,
        rateLimit,
        refreshRateLimit,
        reset,
        transition,
      };
    }

    return {
      RUNNING_PHASES,
      createController,
    };
  },
);
