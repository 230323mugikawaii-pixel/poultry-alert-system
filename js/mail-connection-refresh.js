"use strict";

(function initializeMailConnectionRefresh(root, factory) {
  const refresh = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = refresh;
  }

  if (root) {
    root.CallNowMailConnectionRefresh = refresh;
  }
})(
  typeof globalThis === "object" ? globalThis : this,
  function createRefresh() {
    function createCoordinator({ load, onStateChange, now = Date.now }) {
      if (typeof load !== "function" || typeof onStateChange !== "function") {
        throw new TypeError("load and onStateChange are required");
      }

      let generation = 0;
      let activeController = null;
      let state = {
        status: "idle",
        reason: "initial",
        confirmedAt: null,
      };

      function publish(nextState, value) {
        state = Object.freeze(nextState);
        onStateChange(state, value);
      }

      function invalidate(reason = "change") {
        generation += 1;
        activeController?.abort();
        activeController = null;
        publish({
          status: "loading",
          reason,
          confirmedAt: state.confirmedAt,
        });
      }

      async function refresh({ reason = "refresh", showLoading = true } = {}) {
        const requestGeneration = generation + 1;
        generation = requestGeneration;
        activeController?.abort();
        const controller =
          typeof AbortController === "function" ? new AbortController() : null;
        activeController = controller;

        if (showLoading || state.status !== "ready") {
          publish({
            status: "loading",
            reason,
            confirmedAt: state.confirmedAt,
          });
        }

        try {
          const value = await load({
            reason,
            signal: controller?.signal,
          });

          if (requestGeneration !== generation) {
            return { applied: false, ok: true, value };
          }

          activeController = null;
          publish(
            {
              status: "ready",
              reason,
              confirmedAt: now(),
            },
            value,
          );
          return { applied: true, ok: true, value };
        } catch (error) {
          const isAbort =
            controller?.signal.aborted || error?.name === "AbortError";
          if (requestGeneration !== generation || isAbort) {
            return { applied: false, ok: false, aborted: true, error };
          }

          activeController = null;
          publish({
            status: "error",
            reason,
            confirmedAt: state.confirmedAt,
          });
          return { applied: true, ok: false, error };
        }
      }

      function reset() {
        generation += 1;
        activeController?.abort();
        activeController = null;
        publish({
          status: "idle",
          reason: "reset",
          confirmedAt: null,
        });
      }

      return {
        getState: () => state,
        invalidate,
        refresh,
        reset,
      };
    }

    return { createCoordinator };
  },
);
