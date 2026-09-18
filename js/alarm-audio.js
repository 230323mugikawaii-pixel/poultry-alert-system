"use strict";

(function initializeAlarmAudio(root, factory) {
  const alarmAudio = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = alarmAudio;
  }

  if (root) {
    root.CallNowAlarmAudio = alarmAudio;
  }
})(
  typeof globalThis === "object" ? globalThis : this,
  function createAlarmAudio() {
    const FAILURE_DETAILS = {
      NOT_ALLOWED: {
        controlMessage:
          "通知音を有効化できませんでした。Safariで「通知音を有効にする」を押してください。",
        modalMessage:
          "Safariが通知音の自動再生を許可していません。「通知音を鳴らす」を押してください。",
      },
      ABORTED: {
        controlMessage:
          "通知音の再生が中断されました。もう一度「通知音を有効にする」を押してください。",
        modalMessage:
          "通知音の再生が中断されました。「通知音を鳴らす」を押してください。",
      },
      NOT_SUPPORTED: {
        controlMessage:
          "このブラウザでは通知音を有効化できませんでした。ブラウザを更新してもう一度お試しください。",
        modalMessage:
          "このブラウザでは通知音を再生できません。ブラウザを更新してもう一度お試しください。",
      },
      CONTEXT_INTERRUPTED: {
        controlMessage:
          "通知音が一時停止されました。画面を開いた状態で「通知音を有効にする」を押してください。",
        modalMessage:
          "通知音が一時停止されました。「通知音を鳴らす」を押してください。",
      },
      PLAYBACK_TIMEOUT: {
        controlMessage:
          "通知音の確認が時間内に完了しませんでした。もう一度「通知音を有効にする」を押してください。",
        modalMessage:
          "通知音の開始を確認できませんでした。「通知音を鳴らす」を押してください。",
      },
      UNKNOWN: {
        controlMessage:
          "通知音を有効化できませんでした。ブラウザの音声設定を確認して、もう一度お試しください。",
        modalMessage:
          "通知音を開始できませんでした。「通知音を鳴らす」を押してください。",
      },
    };

    function createPlaybackError(name, message) {
      const error = new Error(message || name);
      error.name = name;
      return error;
    }

    function classifyPlaybackError(error, contextState = "unknown") {
      const name =
        typeof error?.name === "string" && error.name
          ? error.name
          : "Error";
      let code = "UNKNOWN";

      if (name === "NotAllowedError") {
        code = "NOT_ALLOWED";
      } else if (name === "AbortError") {
        code = "ABORTED";
      } else if (name === "NotSupportedError") {
        code = "NOT_SUPPORTED";
      } else if (
        name === "AudioContextInterruptedError" ||
        name === "AudioContextSuspendedError" ||
        contextState === "interrupted" ||
        contextState === "suspended" ||
        contextState === "closed"
      ) {
        code = "CONTEXT_INTERRUPTED";
      } else if (name === "AudioPlaybackTimeoutError") {
        code = "PLAYBACK_TIMEOUT";
      }

      return Object.freeze({
        code,
        contextState,
        name,
        ...FAILURE_DETAILS[code],
      });
    }

    async function resumeAudioContext(context) {
      if (!context) {
        throw createPlaybackError(
          "NotSupportedError",
          "Web Audio API is unavailable",
        );
      }

      if (
        context.state === "suspended" ||
        context.state === "interrupted"
      ) {
        await context.resume();
      }

      if (context.state !== "running") {
        throw createPlaybackError(
          "AudioContextSuspendedError",
          `AudioContext is ${context.state || "unknown"}`,
        );
      }

      return context;
    }

    function createTone(
      context,
      {
        duration = 0.16,
        frequency = 660,
        startTime = context?.currentTime + 0.02,
        timeoutMilliseconds = 1500,
        type = "sine",
        volume = 0.12,
      } = {},
    ) {
      if (!context) {
        throw createPlaybackError(
          "NotSupportedError",
          "Web Audio API is unavailable",
        );
      }
      if (context.state !== "running") {
        throw createPlaybackError(
          "AudioContextSuspendedError",
          `AudioContext is ${context.state || "unknown"}`,
        );
      }

      const oscillator = context.createOscillator();
      const gain = context.createGain();
      let settled = false;
      let timeoutId = null;
      let resolveCompletion;
      let rejectCompletion;

      const completion = new Promise((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });

      function disconnect() {
        try {
          oscillator.disconnect();
        } catch {
          /* Node may already be disconnected. */
        }
        try {
          gain.disconnect();
        } catch {
          /* Node may already be disconnected. */
        }
      }

      function settle(ok, value) {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) {
          globalThis.clearTimeout(timeoutId);
          timeoutId = null;
        }
        disconnect();
        if (ok) resolveCompletion(value);
        else rejectCompletion(value);
      }

      oscillator.addEventListener(
        "ended",
        () => settle(true, { completed: true }),
        { once: true },
      );

      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, startTime);
      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.exponentialRampToValueAtTime(
        Math.max(0.0001, volume),
        startTime + 0.02,
      );
      gain.gain.setValueAtTime(
        Math.max(0.0001, volume),
        startTime + Math.max(0.03, duration - 0.04),
      );
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        startTime + duration,
      );
      oscillator.connect(gain);
      gain.connect(context.destination);

      try {
        oscillator.start(startTime);
        oscillator.stop(startTime + duration);
      } catch (error) {
        settle(false, error);
      }

      if (!settled) {
        timeoutId = globalThis.setTimeout(() => {
          settle(
            false,
            createPlaybackError(
              "AudioPlaybackTimeoutError",
              "Audio playback did not complete",
            ),
          );
        }, timeoutMilliseconds);
      }

      return {
        completion,
        stop() {
          if (settled) return;
          try {
            oscillator.stop();
          } catch {
            /* The scheduled oscillator may already be stopped. */
          }
          settle(true, { completed: false, stopped: true });
        },
      };
    }

    async function verifyUserGesturePlayback(context) {
      await resumeAudioContext(context);
      const confirmation = createTone(context, {
        duration: 0.18,
        frequency: 660,
        timeoutMilliseconds: 1800,
        type: "sine",
        volume: 0.14,
      });
      await confirmation.completion;

      if (context.state !== "running") {
        throw createPlaybackError(
          "AudioContextInterruptedError",
          `AudioContext changed to ${context.state || "unknown"}`,
        );
      }

      return true;
    }

    function transitionPlaybackState(currentState, event) {
      if (event === "INITIAL_START") return "STARTING";
      if (event === "PATTERN_COMPLETED") {
        return currentState === "STARTING" || currentState === "PLAYING"
          ? "PLAYING"
          : currentState;
      }
      if (event === "BLOCK") return "BLOCKED";
      if (event === "STOP") return "STOPPED";
      return currentState;
    }

    function waitForModalPaintBoundary({
      isVisible,
      requestFrame,
    }) {
      if (!isVisible || typeof requestFrame !== "function") {
        return Promise.resolve("SKIPPED_BACKGROUND");
      }
      return new Promise((resolve) => {
        requestFrame(() => {
          requestFrame(() => resolve("PAINT_FRAME"));
        });
      });
    }

    return {
      classifyPlaybackError,
      createPlaybackError,
      createTone,
      resumeAudioContext,
      transitionPlaybackState,
      verifyUserGesturePlayback,
      waitForModalPaintBoundary,
    };
  },
);
