"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CallNowHtmlAlarmAudio = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  // Same-origin static assets; one element retains Safari's per-element permission.
  const SOURCES = Object.freeze({
    confirmation: "audio/confirmation-v1.wav",
    pattern: "audio/alarm-v1.wav",
    loop: "audio/alarm-loop-v2.wav",
  });
  const PATTERN_PERIOD_MS = 1300;

  function playbackError(name) {
    const error = new Error(name);
    error.name = name;
    return error;
  }

  function createPlayer({
    createAudio = () => new Audio(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    timeoutMilliseconds = 5000,
    recoveryTimeoutMilliseconds = 750,
    maxConsecutiveRecoveries = 2,
    now = () => performance.now(),
    wallNow = () => Date.now(),
  } = {}) {
    let media = null;
    let current = null;
    let sequence = 0;
    const diagnostics = [];

    // Bounded, memory-only evidence. Never includes URLs, identity or Alert data.
    function trace(event) {
      diagnostics.push(event);
      if (diagnostics.length > 256) diagnostics.shift();
    }

    function silence(element) {
      element.pause();
      element.loop = false;
      try {
        element.currentTime = 0;
      } catch {
        // Metadata may not yet be loaded. pause still prevents playback.
      }
    }

    function stop() {
      if (current) current.stop();
      else if (media) silence(media);
    }

    function play(kind, { signal } = {}) {
      stop();
      if (signal?.aborted) throw playbackError("AbortError");
      if (!media) media = createAudio();
      const element = media;
      element.preload = "auto";
      element.loop = false; // Repetition belongs to the existing guarded app timer.
      element.muted = false;
      element.volume = 1;
      if (element.getAttribute("src") !== SOURCES[kind]) {
        element.src = SOURCES[kind];
      }
      try {
        element.currentTime = 0;
      } catch {
        // A newly selected static resource can have no metadata yet.
      }

      let settled = false;
      let accepted = false;
      let ended = false;
      let cancelled = false;
      let timer;
      let resolve;
      let reject;
      const completion = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const listeners = [];
      function listen(name, callback) {
        element.addEventListener(name, callback);
        listeners.push([name, callback]);
      }
      function finish(error) {
        if (settled) return;
        settled = true;
        cancelled = Boolean(error);
        clearTimer(timer);
        listeners.forEach(([name, callback]) =>
          element.removeEventListener(name, callback),
        );
        signal?.removeEventListener("abort", cancel);
        if (current === operation) current = null;
        if (error) {
          silence(element);
          if (!accepted) {
            // A cancelled native play() may resolve later. Retire that element
            // so it cannot stop (or restart) a newer playback on the shared one.
            if (media === element) media = null;
            element.removeAttribute("src");
            element.load();
          }
          reject(error);
        } else {
          resolve({ completed: true });
        }
      }
      function completeIfReady() {
        if (accepted && ended) finish();
      }
      function cancel() {
        finish(playbackError("AbortError"));
      }
      const operation = { completion, stop: cancel };
      current = operation;
      listen("ended", () => {
        if (!element.ended) return;
        if (!(element.currentTime >= 0.1)) {
          finish(playbackError("AudioPlaybackInterruptedError"));
          return;
        }
        ended = true;
        completeIfReady();
      });
      listen("error", () => {
        if (!element.error) return;
        finish(
          playbackError(
            element.error?.code === 4 ? "NotSupportedError" : "NetworkError",
          ),
        );
      });
      // Changing src queues abort for the PREVIOUS resource. A native play()
      // AbortError is handled by its Promise; loading stalls have a deadline.
      listen("pause", () => {
        if (element.paused && !element.ended)
          finish(playbackError("AudioPlaybackInterruptedError"));
      });
      signal?.addEventListener("abort", cancel, { once: true });
      // Per-playback failure deadline, NOT a limit on the alarm's total duration.
      // Successful completion clears it before the next guarded app cycle.
      timer = setTimer(
        () => finish(playbackError("AudioPlaybackTimeoutError")),
        timeoutMilliseconds,
      );
      try {
        // No await before play(): explicit retry retains the real click gesture.
        Promise.resolve(element.play()).then(
          () => {
            if (cancelled) {
              silence(element);
              return;
            }
            accepted = true;
            completeIfReady();
          },
          (error) => finish(error),
        );
      } catch (error) {
        finish(error);
      }
      return operation;
    }

    function playLoop({
      signal,
      onFailure = () => {},
      onCycle = () => {},
      onRecovery = () => {},
      onFirstPlayback = () => {},
    } = {}) {
      stop();
      if (signal?.aborted) throw playbackError("AbortError");
      if (!media) media = createAudio();
      let element = media;
      const operationId = ++sequence,
        startedAt = now();
      element.preload = "auto";
      element.src = SOURCES.loop;
      // Safari can stop advancing at a native-loop/seek-to-zero boundary.
      // Reuse the authorized element, but reload the resource after natural end.
      element.loop = false;
      element.muted = false;
      element.volume = 1;
      let closed = false,
        completed = false,
        accepted = false;
      let cycle = 0,
        previousTime = 0,
        progressed = false;
      let consecutiveRecoveries = 0,
        recovering = false,
        firstPlayback = null;
      let deadline,
        deadlineVersion = 0;
      let resolve, reject;
      const completion = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      let listeners = [];
      function record(event) {
        trace({
          operationId,
          cycle,
          event,
          epochMilliseconds: wallNow(),
          elapsedMs: Math.round(now() - startedAt),
          mediaTimeMs: Math.round(element.currentTime * 1000),
          accepted,
          firstPatternComplete: completed,
          paused: element.paused,
          ended: element.ended,
          readyState: element.readyState,
          networkState: element.networkState,
          durationMs: Number.isFinite(element.duration)
            ? Math.round(element.duration * 1000)
            : null,
          seeking: element.seeking,
          errorCode: element.error?.code || null,
          consecutiveRecoveries,
        });
      }
      function listen(name, cycleId, fn) {
        const observedElement = element;
        const handler = () => {
          if (!closed && cycleId === cycle && element === observedElement) {
            record(name);
            fn?.();
          }
        };
        observedElement.addEventListener(name, handler);
        listeners.push([observedElement, name, handler]);
      }
      function clearCycle() {
        clearTimer(deadline);
        ++deadlineVersion;
        listeners.forEach(([target, name, fn]) =>
          target.removeEventListener(name, fn),
        );
        listeners = [];
      }
      function finish(error, phase, cancellation = false) {
        if (closed) return;
        closed = true;
        clearCycle();
        signal?.removeEventListener("abort", cancel);
        if (current === operation) current = null;
        record(cancellation ? "CANCELLED" : phase);
        silence(element);
        record("STOPPED");
        // A still-pending native Promise belongs only to this retired element.
        if (!accepted) {
          if (media === element) media = null;
          element.removeAttribute("src");
          element.load();
        }
        if (error) error.playbackPhase = phase;
        if (!completed) reject(error);
        else if (!cancellation) onFailure(error);
      }
      function cancel() {
        finish(playbackError("AbortError"), "loop-cancelled", true);
      }
      function recover(error, phase) {
        if (closed || signal?.aborted) return;
        if (!completed || consecutiveRecoveries >= maxConsecutiveRecoveries) {
          finish(error, phase);
          return;
        }
        clearCycle();
        ++consecutiveRecoveries;
        recovering = true;
        record("RECOVERY_STARTED");
        // Never reuse a pending native play Promise's element. Disconnect its
        // resource before making the replacement; stale callbacks capture it.
        const retired = element;
        silence(retired);
        retired.removeAttribute("src");
        retired.load();
        if (media === retired) media = null;
        onRecovery({ recovering: true, attempt: consecutiveRecoveries, phase });
        if (closed || signal?.aborted) return;
        try {
          element = createAudio();
          media = element;
          element.preload = "auto";
          element.src = SOURCES.loop;
          element.loop = false;
          element.muted = false;
          element.volume = 1;
          beginCycle();
        } catch (failure) {
          finish(failure, "loop-recovery-failed");
        }
      }
      function observeProgress(cycleId) {
        if (closed || cycleId !== cycle || element.paused || element.error)
          return false;
        const time = element.currentTime;
        if (time <= previousTime + 0.001) return false;
        previousTime = time;
        // Progress is stronger evidence than a stalled native play Promise.
        // Do not retire an element that is demonstrably advancing.
        if (!accepted) {
          accepted = true;
          record("NATIVE_PROGRESS_CONFIRMED");
        }
        if (!progressed) {
          progressed = true;
          record("START_DEADLINE_CLEARED");
        }
        armDeadline(cycleId);
        return true;
      }
      function completeCycle(cycleId) {
        if (closed || cycleId !== cycle || !accepted || !element.ended)
          return false;
        if (element.currentTime < 0.89) {
          finish(
            playbackError("AudioPlaybackInterruptedError"),
            "loop-premature-ended",
          );
          return true;
        }
        clearCycle();
        record("CYCLE_COMPLETE");
        consecutiveRecoveries = 0;
        if (recovering) {
          recovering = false;
          record("RECOVERY_COMPLETED");
          onRecovery({ recovering: false, attempt: 0, phase: "loop-recovered" });
        }
        if (!completed) {
          completed = true;
          record("FIRST_PATTERN_COMPLETE");
          resolve({ completed: true });
        } else onCycle();
        // No currentTime assignment, native loop or repeat timer here.
        // Detach old listeners before load() queues old-resource events.
        if (!closed && !signal?.aborted) beginCycle();
        return true;
      }
      function armDeadline(cycleId) {
        clearTimer(deadline);
        const version = ++deadlineVersion;
        deadline = setTimer(() => {
          if (closed || cycleId !== cycle || version !== deadlineVersion)
            return;
          // A delayed event alone is not failure. Inspect native state first.
          if (completeCycle(cycleId) || observeProgress(cycleId)) return;
          const startupTimeout = !completed && !accepted;
          recover(
            playbackError(
              startupTimeout
                ? "AudioPlaybackTimeoutError"
                : "AudioPlaybackStalledError",
            ),
            !accepted
              ? "loop-play-promise-timeout"
              : progressed
                ? "loop-progress-stalled"
                : "loop-no-progress",
          );
        }, completed ? recoveryTimeoutMilliseconds : timeoutMilliseconds);
      }
      function beginCycle() {
        if (closed || signal?.aborted) return;
        const cycleId = ++cycle;
        const cycleElement = element;
        accepted = false;
        progressed = false;
        previousTime = 0;
        // load() resets the decoder; currentTime=0 and native loop both seek
        // within the previous resource, the path that stalled in Safari E2E.
        element.load();
        record("RESOURCE_RELOADED");
        listen("timeupdate", cycleId, () => observeProgress(cycleId));
        listen("playing", cycleId, () => {
          if (!firstPlayback && !element.paused && !element.ended) {
            firstPlayback = Object.freeze({
              epochMilliseconds: wallNow(),
              mediaTimeMilliseconds: Math.round(element.currentTime * 1000),
              operationId,
            });
            onFirstPlayback({ ...firstPlayback });
          }
        });
        for (const name of [
          "play",
          "waiting",
          "stalled",
          "suspend",
          "seeking",
          "seeked",
        ])
          listen(name, cycleId);
        listen("ended", cycleId, () => completeCycle(cycleId));
        listen("pause", cycleId, () => {
          if (element.paused && !element.ended)
            finish(
              playbackError("AudioPlaybackInterruptedError"),
              "loop-paused",
            );
        });
        listen("error", cycleId, () => {
          if (element.error)
            finish(
              playbackError(
                element.error.code === 4 ? "NotSupportedError" : "NetworkError",
              ),
              "loop-media-error",
            );
        });
        armDeadline(cycleId);
        record("PLAY_CALL");
        try {
          // First play stays inside the actual click, without awaiting load.
          Promise.resolve(cycleElement.play()).then(
            () => {
              if (closed || cycleElement !== element) {
                if (cycleElement !== element || !accepted) silence(cycleElement);
                return;
              }
              if (cycleId !== cycle) return;
              accepted = true;
              record("PLAY_RESOLVED");
              if (!completeCycle(cycleId)) observeProgress(cycleId);
            },
            (error) => {
              if (!closed && cycleId === cycle)
                finish(error, "loop-play-rejected");
            },
          );
        } catch (error) {
          finish(error, "loop-play-threw");
        }
      }
      const operation = {
        completion,
        stop: cancel,
        getFirstPlayback: () => firstPlayback && { ...firstPlayback },
      };
      current = operation;
      signal?.addEventListener("abort", cancel, { once: true });
      beginCycle();
      return operation;
    }

    return {
      playConfirmation: (options) => play("confirmation", options),
      playPattern: (options) => play("pattern", options),
      playLoop,
      getDiagnostics: () => diagnostics.map((event) => ({ ...event })),
      stop,
    };
  }

  return { createPlayer, SOURCES, PATTERN_PERIOD_MS };
});
