import assert from "node:assert/strict";
import test from "node:test";

import alarmAudio from "../js/alarm-audio.js";

function createFakeAudioContext({
  initialState = "suspended",
  resumeError = null,
  resumeState = "running",
  endTone = true,
} = {}) {
  const context = {
    currentTime: 10,
    destination: {},
    state: initialState,
    resumeCalls: 0,
    createOscillator() {
      const listeners = new Map();
      return {
        frequency: { setValueAtTime() {} },
        addEventListener(name, listener) {
          listeners.set(name, listener);
        },
        connect() {},
        disconnect() {},
        start() {},
        stop() {
          if (endTone) queueMicrotask(() => listeners.get("ended")?.());
        },
        type: "sine",
      };
    },
    createGain() {
      return {
        connect() {},
        disconnect() {},
        gain: {
          exponentialRampToValueAtTime() {},
          setValueAtTime() {},
        },
      };
    },
    async resume() {
      this.resumeCalls += 1;
      if (resumeError) throw resumeError;
      this.state = resumeState;
    },
  };
  return context;
}

test("classifies browser playback failures without exposing error text", () => {
  assert.equal(
    alarmAudio.classifyPlaybackError({ name: "NotAllowedError" }, "suspended")
      .code,
    "NOT_ALLOWED",
  );
  assert.equal(
    alarmAudio.classifyPlaybackError({ name: "AbortError" }, "running").code,
    "ABORTED",
  );
  assert.equal(
    alarmAudio.classifyPlaybackError({ name: "NotSupportedError" }, "running")
      .code,
    "NOT_SUPPORTED",
  );
  const unknown = alarmAudio.classifyPlaybackError(
    { name: "Error", message: "sensitive browser detail" },
    "running",
  );
  assert.equal(unknown.code, "UNKNOWN");
  assert.doesNotMatch(unknown.controlMessage, /sensitive browser detail/);
});

test("explicit enablement resumes Safari audio and waits for a rendered tone", async () => {
  const context = createFakeAudioContext();
  assert.equal(await alarmAudio.verifyUserGesturePlayback(context), true);
  assert.equal(context.resumeCalls, 1);
  assert.equal(context.state, "running");
});

test("a rejected resume remains a distinct NotAllowedError", async () => {
  const error = new Error("autoplay policy detail");
  error.name = "NotAllowedError";
  const context = createFakeAudioContext({ resumeError: error });

  await assert.rejects(
    alarmAudio.verifyUserGesturePlayback(context),
    (received) => received.name === "NotAllowedError",
  );
  assert.equal(
    alarmAudio.classifyPlaybackError(error, context.state).code,
    "NOT_ALLOWED",
  );
});

test("a context that stays suspended is not reported as ready", async () => {
  const context = createFakeAudioContext({ resumeState: "suspended" });
  await assert.rejects(
    alarmAudio.verifyUserGesturePlayback(context),
    (error) => error.name === "AudioContextSuspendedError",
  );
});

test("tone completion timeout is surfaced instead of reporting playback", async () => {
  const context = createFakeAudioContext({
    initialState: "running",
    endTone: false,
  });
  const tone = alarmAudio.createTone(context, {
    timeoutMilliseconds: 5,
  });
  await assert.rejects(
    tone.completion,
    (error) => error.name === "AudioPlaybackTimeoutError",
  );
});

test("locally stopping a tone completes it without a later timeout", async () => {
  const context = createFakeAudioContext({
    initialState: "running",
    endTone: false,
  });
  const tone = alarmAudio.createTone(context, {
    timeoutMilliseconds: 10,
  });

  tone.stop();

  assert.deepEqual(await tone.completion, {
    completed: false,
    stopped: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("repeated patterns remain PLAYING after the first completed cycle", () => {
  let state = alarmAudio.transitionPlaybackState("IDLE", "INITIAL_START");
  assert.equal(state, "STARTING");

  state = alarmAudio.transitionPlaybackState(state, "PATTERN_COMPLETED");
  assert.equal(state, "PLAYING");

  for (let cycle = 0; cycle < 10; cycle += 1) {
    state = alarmAudio.transitionPlaybackState(state, "PATTERN_COMPLETED");
    assert.equal(state, "PLAYING");
  }

  state = alarmAudio.transitionPlaybackState(state, "STOP");
  assert.equal(state, "STOPPED");
  assert.equal(
    alarmAudio.transitionPlaybackState(state, "PATTERN_COMPLETED"),
    "STOPPED",
  );
});

test("visible alarm waits for two animation frames before audio", async () => {
  const frames = [];
  const pending = alarmAudio.waitForModalPaintBoundary({
    isVisible: true,
    requestFrame: (callback) => frames.push(callback),
  });

  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(await pending, "PAINT_FRAME");
});

test("background alarm does not wait for animation frames", async () => {
  let frameRequests = 0;
  const result = await alarmAudio.waitForModalPaintBoundary({
    isVisible: false,
    requestFrame: () => {
      frameRequests += 1;
    },
  });

  assert.equal(result, "SKIPPED_BACKGROUND");
  assert.equal(frameRequests, 0);
});
