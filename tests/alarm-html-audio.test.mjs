import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import htmlAudio from "../js/alarm-html-audio.js";
import alarmAudio from "../js/alarm-audio.js";

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function clock() {
  let now = 0,
    id = 0;
  const timers = new Map();
  return {
    set: (callback, delay) => {
      timers.set(++id, { at: now + delay, callback });
      return id;
    },
    clear: (key) => timers.delete(key),
    now: () => now,
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const entry = [...timers]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        timers.delete(entry[0]);
        now = entry[1].at;
        entry[1].callback();
        await flush();
      }
      now = end;
      await flush();
    },
    get size() {
      return timers.size;
    },
  };
}
class FakeAudio {
  listeners = new Map();
  currentTime = 0;
  paused = true;
  ended = false;
  loop = false;
  plays = 0;
  loads = 0;
  playResult = () => Promise.resolve();
  getAttribute() {
    return this.src;
  }
  removeAttribute() {
    this.src = "";
  }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
  }
  removeEventListener(name, fn) {
    this.listeners.get(name)?.delete(fn);
  }
  emit(name) {
    for (const fn of [...(this.listeners.get(name) || [])]) fn();
  }
  play() {
    this.plays++;
    this.ended = false;
    this.paused = false;
    return this.playResult();
  }
  pause() {
    this.paused = true;
    this.emit("pause");
  }
  load() {
    this.loads++;
    this.currentTime = 0;
    this.ended = false;
    this.paused = true;
  }
  end() {
    this.currentTime = 0.94;
    if (this.loop) {
      this.emit("timeupdate");
      return;
    }
    this.ended = true;
    this.paused = true;
    this.emit("ended");
  }
}
function fixture() {
  const time = clock(),
    elements = [];
  const player = htmlAudio.createPlayer({
    createAudio: () => {
      const audio = new FakeAudio();
      elements.push(audio);
      return audio;
    },
    setTimer: time.set,
    clearTimer: time.clear,
    timeoutMilliseconds: 5000,
    now: time.now,
  });
  return {
    time,
    player,
    elements,
    get audio() {
      return elements.at(-1);
    },
  };
}

test("static local PCM resources are valid, audible-level and have expected durations", () => {
  for (const [kind, path] of Object.entries(htmlAudio.SOURCES)) {
    assert.doesNotMatch(path, /https?:|data:|blob:/);
    const data = readFileSync(new URL(`../${path}`, import.meta.url));
    assert.equal(data.toString("ascii", 0, 4), "RIFF");
    assert.equal(data.toString("ascii", 8, 12), "WAVE");
    assert.equal(data.readUInt16LE(20), 1);
    assert.equal(data.readUInt16LE(22), 1);
    assert.equal(data.readUInt32LE(24), 44100);
    assert.equal(data.readUInt32LE(40), data.length - 44);
    assert.equal(
      (data.length - 44) / 88200,
      { pattern: 0.94, confirmation: 0.5, loop: 1.3 }[kind],
    );
    let peak = 0;
    for (let i = 44; i < data.length; i += 2)
      peak = Math.max(peak, Math.abs(data.readInt16LE(i)) / 32767);
    assert.ok(peak >= 0.24 && peak <= 0.29);
  }
});
test("confirmation and pattern reuse one element; completion requires play acceptance AND ended", async () => {
  const f = fixture();
  const confirm = f.player.playConfirmation();
  assert.equal(f.audio.plays, 1, "play invoked synchronously in gesture");
  let completed = false;
  confirm.completion.then(() => {
    completed = true;
  });
  await flush();
  assert.equal(completed, false);
  f.audio.end();
  await confirm.completion;
  const tone = f.player.playPattern();
  assert.equal(f.elements.length, 1);
  assert.equal(f.audio.src, htmlAudio.SOURCES.pattern);
  assert.equal(f.audio.loop, false);
  f.audio.end();
  await tone.completion;
  assert.equal(f.time.size, 0);
});
test("queued events from the previous src cannot abort the next pattern", async () => {
  const f = fixture();
  const confirmation = f.player.playConfirmation();
  f.audio.end();
  await confirmation.completion;
  const next = f.player.playPattern();
  f.audio.emit("abort");
  f.audio.emit("pause"); // Current media is playing, not paused.
  f.audio.emit("ended"); // Current media has not ended.
  f.audio.emit("error"); // Current media has no MediaError.
  await flush();
  assert.equal(f.audio.paused, false);
  f.audio.end();
  await next.completion;
});
for (const name of ["NotAllowedError", "AbortError", "NotSupportedError"]) {
  test(`native play rejection ${name} is preserved, caught and silenced`, async () => {
    const f = fixture();
    const initial = f.player.playPattern();
    f.audio.end();
    await initial.completion;
    const audio = f.audio;
    audio.playResult = () =>
      Promise.reject(
        Object.assign(new Error("do not expose details"), { name }),
      );
    await assert.rejects(f.player.playPattern().completion, { name });
    assert.equal(audio.paused, true);
    assert.equal(audio.currentTime, 0);
    assert.equal(f.time.size, 0);
  });
}
test("pending play timeout and late fulfillment cannot restart or silence newer playback", async () => {
  const f = fixture();
  const initial = f.player.playPattern();
  f.audio.end();
  await initial.completion;
  const old = f.audio,
    pending = deferred();
  old.playResult = () => pending.promise;
  const timed = f.player.playPattern().completion;
  const rejected = assert.rejects(timed, { name: "AudioPlaybackTimeoutError" });
  await f.time.advance(5000);
  await rejected;
  const newer = f.player.playPattern();
  const fresh = f.audio;
  assert.notEqual(old, fresh);
  old.paused = false;
  pending.resolve();
  await flush();
  assert.equal(old.paused, true);
  assert.equal(fresh.paused, false);
  fresh.end();
  await newer.completion;
  await f.time.advance(11000);
  assert.equal(fresh.plays, 1);
});
test("pagehide-style cancellation catches late native rejection and stops all local media", async () => {
  const f = fixture(),
    signal = new AbortController(),
    pending = deferred();
  const first = f.player.playPattern();
  f.audio.end();
  await first.completion;
  const audio = f.audio;
  audio.playResult = () => pending.promise;
  const playback = f.player.playPattern({ signal: signal.signal });
  const rejected = assert.rejects(playback.completion, { name: "AbortError" });
  signal.abort();
  await rejected;
  pending.reject(Object.assign(new Error(), { name: "NotAllowedError" }));
  await flush();
  await f.time.advance(11000);
  assert.equal(audio.paused, true);
  assert.equal(audio.currentTime, 0);
  assert.equal(f.time.size, 0);
});
test("interruption, decode failure, absent ended and cancelled-before-start are not success", async () => {
  for (const failure of ["pause", "error", "timeout"]) {
    const f = fixture(),
      operation = f.player.playPattern();
    await flush();
    const expected = {
      pause: "AudioPlaybackInterruptedError",
      error: "NotSupportedError",
      timeout: "AudioPlaybackTimeoutError",
    }[failure];
    const rejected = assert.rejects(operation.completion, { name: expected });
    if (failure === "timeout") await f.time.advance(5000);
    else {
      if (failure === "pause") f.audio.paused = true;
      f.audio.error = { code: 4 };
      f.audio.emit(failure);
    }
    await rejected;
  }
  const f = fixture(),
    cancellation = new AbortController();
  cancellation.abort();
  assert.throws(() => f.player.playPattern({ signal: cancellation.signal }), {
    name: "AbortError",
  });
  assert.equal(f.elements.length, 0);
});

const app = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
function applicationFunction(name) {
  return app.match(
    new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}$`, "m"),
  )[0];
}
function applicationFixture() {
  const f = fixture(),
    listeners = new Map(),
    ui = new Map(),
    states = [],
    preferences = [];
  function element(id) {
    if (!ui.has(id))
      ui.set(id, {
        classList: { contains: () => false, add() {}, remove() {} },
        addEventListener(name, fn) {
          this[name] = fn;
        },
      });
    return ui.get(id);
  }
  const scope = vm.createContext({
    AbortController,
    DOMException,
    console: { info() {}, warn() {} },
    alarmAudioPolicy: alarmAudio,
    htmlAlarmAudioPolicy: { ...htmlAudio, createPlayer: () => f.player },
    performance: { now: f.time.now },
    window: {
      addEventListener: (name, fn) => listeners.set(name, fn),
      setTimeout: f.time.set,
      clearTimeout: f.time.clear,
    },
    document: { getElementById: element, addEventListener() {} },
    updateAllAlarmSoundControls() {},
    updateAlarmModalSoundStatus() {},
    recordAlertPresentationEvent() {},
    setAlarmModalSoundStatus: (text, state) => states.push(state),
    saveAlarmSoundPreference: (value) => preferences.push(value),
    stopCurrentAlarmLocally() {},
    handleAlarmModalKeydown() {},
    handleExternalAlertPresentation() {},
    closeAlarmNotification() {},
    alertTabCoordinator: { subscribe() {} },
  });
  vm.runInContext(
    `
    const ALARM_AUDIO_BACKEND = "html";
    let alarmHtmlAudio = null, alarmEnableAfterPlayback = false, alarmAudioContext = null;
    let alarmPageActive = true, alarmPlaybackGeneration = 0;
    let alarmAudioAbortController = new AbortController();
    let alarmSoundEnabled = true, alarmIsActive = false, alarmPlaybackState = "IDLE";
    let alarmPlaybackCycleCount = 0, alarmRepeatTimer = null, alarmActiveNodes = [];
    let alarmAudioResumeInProgress = false, alarmAudioVerificationState = "UNVERIFIED";
    let alarmSoundError = "", alarmAudioLastFailure = null;
    const currentAlarmAlertContext = { alertId: "fixture-alert", audience: "OWNER" };
    ${["getHtmlAlarmAudio", "classifyAlarmAudioFailure", "recordAlarmAudioFailure", "failActiveAlarmPlayback", "showAlarmAudioFallback", "stopAlarmSound", "startAlarmSound", "playAlarmPattern", "unlockAlarmAudio", "enableAlarmAudio", "enableAlarmSoundForCurrentAlert", "initializeAlarmNotification"].map(applicationFunction).join("\n")}
    initializeAlarmNotification();
  `,
    scope,
  );
  return {
    ...f,
    audio: () => f.audio,
    listeners,
    states,
    preferences,
    ui,
    run: (code) => vm.runInContext(code, scope),
  };
}
test("app confirmation cannot display READY before completion or after pagehide", async () => {
  const f = applicationFixture(),
    pending = f.run('enableAlarmAudio("OWNER")');
  assert.equal(f.audio().plays, 1);
  assert.equal(f.run("alarmAudioVerificationState"), "VERIFYING");
  f.audio().end();
  assert.equal(await pending, true);
  assert.equal(f.run("alarmAudioVerificationState"), "READY");
  const later = f.run('enableAlarmAudio("OWNER")');
  f.listeners.get("pagehide")();
  f.listeners.get("pageshow")();
  f.audio().end();
  assert.equal(await later, false);
  assert.deepEqual(f.preferences, [true]);
});
test("explicit click uses one initial POST-free playback; cycles never flicker STARTING", async () => {
  const f = applicationFixture();
  f.ui.get("restartAlarmButton").click();
  assert.equal(f.audio().plays, 1, "native play is inside the click");
  f.ui.get("restartAlarmButton").click();
  assert.equal(f.audio().plays, 1, "double click cannot create another player");
  for (let i = 0; i < 4; i++) {
    await flush();
    f.audio().end();
    await flush();
    assert.equal(f.run("alarmPlaybackState"), "PLAYING");
  }
  assert.deepEqual(f.states, ["starting", "playing"]);
  assert.deepEqual(f.preferences, [true]);
  f.run("stopAlarmSound()");
  const plays = f.audio().plays;
  await f.time.advance(11000);
  assert.equal(f.audio().plays, plays);
  assert.equal(f.audio().paused, true);
  assert.equal(f.audio().currentTime, 0);
  assert.equal(f.run("alarmPlaybackState"), "STOPPED");
  assert.equal(f.time.size, 0);
});

test("resource reload after natural ended runs >45s with one element and no native seek/loop", async () => {
  const f = applicationFixture();
  void f.run("startAlarmSound()");
  const element = f.audio(),
    starts = [f.time.now()];
  for (let i = 0; i < 36; i++) {
    await flush();
    for (let tick = 1; tick <= 5; tick++) {
      element.currentTime = tick * 0.25;
      element.emit("timeupdate");
      await f.time.advance(250);
    }
    await f.time.advance(50);
    element.end();
    await flush();
    starts.push(f.time.now());
    assert.equal(f.audio(), element);
    assert.equal(element.loop, false);
    assert.equal(element.loads, i + 2);
    assert.equal(element.plays, i + 2);
    assert.equal(f.run("alarmPlaybackCycleCount"), i + 1);
    assert.equal(f.run("alarmPlaybackState"), "PLAYING");
  }
  assert.equal(f.time.now(), 46800);
  assert.deepEqual(
    starts.slice(1).map((t, i) => t - starts[i]),
    Array(36).fill(1300),
  );
  assert.deepEqual(f.states, ["starting", "playing"]);
  f.run("stopAlarmSound()");
  const plays = element.plays;
  await f.time.advance(11000);
  assert.equal(element.plays, plays);
  assert.equal(element.paused, true);
  assert.equal(f.run("alarmActiveNodes.length"), 0);
  assert.equal(f.time.size, 0);
});

test("startup Promise/no-progress/incomplete pattern timeouts have distinct phases", async () => {
  for (const mode of ["pending", "no-progress", "incomplete"]) {
    const f = fixture(),
      confirm = f.player.playConfirmation();
    f.audio.end();
    await confirm.completion;
    if (mode === "pending") f.audio.playResult = () => new Promise(() => {});
    const run = f.player.playLoop();
    const rejected = assert.rejects(run.completion, {
      name:
        mode === "pending"
          ? "AudioPlaybackTimeoutError"
          : "AudioPlaybackStalledError",
      playbackPhase:
        mode === "pending"
          ? "loop-play-promise-timeout"
          : mode === "no-progress"
            ? "loop-no-progress"
            : "loop-progress-stalled",
    });
    await flush();
    if (mode === "incomplete") {
      f.audio.currentTime = 0.2;
      f.audio.emit("timeupdate");
    }
    await f.time.advance(5000);
    await rejected;
    assert.equal(f.audio.paused, true);
    assert.equal(f.time.size, 0);
  }
});

test("silent media stall AFTER successful cycles changes UI from PLAYING to BLOCKED", async () => {
  const f = applicationFixture();
  void f.run("startAlarmSound()");
  await flush();
  f.audio().end();
  await flush();
  assert.equal(f.run("alarmPlaybackState"), "PLAYING");
  f.audio().currentTime = 0.2;
  f.audio().emit("timeupdate");
  await f.time.advance(5000);
  assert.equal(f.run("alarmPlaybackState"), "BLOCKED");
  assert.equal(f.run("alarmAudioLastFailure.code"), "PLAYBACK_STALLED");
  assert.doesNotMatch(f.run("alarmSoundError"), /開始を確認できません/);
  assert.equal(f.ui.get("restartAlarmButton").textContent, "通知音を再試行");
  assert.equal(f.audio().paused, true);
  assert.equal(f.time.size, 0);
  const plays = f.audio().plays;
  await f.time.advance(11000);
  assert.equal(
    f.audio().plays,
    plays,
    "no unbounded recovery behind the user's back",
  );
});

test("delayed timeupdate/ended do not cause failure when native media has progressed/ended", async () => {
  const f = fixture(),
    failures = [];
  const run = f.player.playLoop({ onFailure: (e) => failures.push(e) });
  await flush();
  f.audio.currentTime = 0.5;
  await f.time.advance(5000);
  assert.equal(f.audio.paused, false);
  f.audio.currentTime = 1.3;
  f.audio.ended = true;
  f.audio.paused = true;
  await f.time.advance(5000);
  await run.completion;
  assert.equal(f.audio.plays, 2);
  assert.deepEqual(failures, []);
  f.player.stop();
});

test("NotAllowed/Abort/NotSupported rejections after first cycle are caught, not PLAYING", async () => {
  for (const name of ["NotAllowedError", "AbortError", "NotSupportedError"]) {
    const f = applicationFixture();
    void f.run("startAlarmSound()");
    await flush();
    f.audio().playResult = () =>
      Promise.reject(Object.assign(new Error(), { name }));
    f.audio().end();
    await flush();
    assert.equal(f.run("alarmPlaybackState"), "BLOCKED");
    assert.equal(f.run("alarmAudioLastFailure.name"), name);
    assert.equal(f.audio().paused, true);
    assert.equal(f.time.size, 0);
  }
});

test("pending old play resolution and events cannot restart or silence a retry", async () => {
  const f = fixture(),
    pending = deferred(),
    failures = [];
  const confirm = f.player.playConfirmation();
  f.audio.end();
  await confirm.completion;
  const old = f.audio;
  old.playResult = () => pending.promise;
  const first = f.player.playLoop({ onFailure: (e) => failures.push(e) });
  const rejected = assert.rejects(first.completion, { name: "AbortError" });
  f.player.stop();
  await rejected;
  const second = f.player.playLoop({ onFailure: (e) => failures.push(e) }),
    fresh = f.audio;
  assert.notEqual(old, fresh);
  await flush();
  fresh.end();
  await second.completion;
  await flush();
  old.paused = false;
  pending.resolve();
  old.emit("ended");
  old.emit("pause");
  old.emit("error");
  await flush();
  assert.equal(old.paused, true);
  assert.equal(fresh.paused, false);
  assert.deepEqual(failures, []);
  f.player.stop();
  await f.time.advance(11000);
  assert.equal(f.time.size, 0);
});

test("queued previous-cycle timer/listeners cannot fail current cycle or duplicate play", async () => {
  const f = fixture(),
    failures = [];
  const run = f.player.playLoop({ onFailure: (e) => failures.push(e) });
  await flush();
  const oldEnded = [...f.audio.listeners.get("ended")][0];
  const oldPause = [...f.audio.listeners.get("pause")][0];
  f.audio.end();
  await run.completion;
  await flush();
  oldEnded();
  oldPause();
  f.audio.emit("ended"); // queued native event, current element is not ended
  assert.equal(f.audio.plays, 2);
  assert.deepEqual(failures, []);
  f.player.stop();
});

test("cancelled deadline queued in event loop cannot affect progress/new cycle/retry", async () => {
  const callbacks = [],
    failures = [],
    a = new FakeAudio();
  const p = htmlAudio.createPlayer({
    createAudio: () => a,
    setTimer: (fn) => (callbacks.push(fn), callbacks.length),
    clearTimer() {},
    now: () => 0,
  });
  const one = p.playLoop({ onFailure: (e) => failures.push(e) });
  await flush();
  a.currentTime = 0.2;
  a.emit("timeupdate");
  const oldCallbacks = callbacks.slice();
  a.end();
  await one.completion;
  await flush();
  oldCallbacks.forEach((fn) => fn());
  assert.equal(a.paused, false);
  p.stop();
  const two = p.playLoop({ onFailure: (e) => failures.push(e) });
  await flush();
  a.end();
  await two.completion;
  await flush();
  oldCallbacks.forEach((fn) => fn());
  assert.equal(a.paused, false);
  assert.deepEqual(failures, []);
  p.stop();
});

test("actual pause/media error/premature end are reported once after successful playback", async () => {
  for (const event of ["pause", "error", "ended"]) {
    const f = fixture(),
      failures = [],
      run = f.player.playLoop({ onFailure: (e) => failures.push(e) });
    await flush();
    f.audio.end();
    await run.completion;
    await flush();
    if (event === "pause") f.audio.paused = true;
    if (event === "error") f.audio.error = { code: 4 };
    if (event === "ended") {
      f.audio.ended = true;
      f.audio.currentTime = 0.1;
    }
    f.audio.emit(event);
    await f.time.advance(11000);
    assert.equal(failures.length, 1);
    assert.equal(f.audio.paused, true);
    assert.equal(f.time.size, 0);
  }
});

test("pagehide while next cycle play is pending invalidates late success and never restarts", async () => {
  const f = applicationFixture(),
    pending = deferred();
  void f.run("startAlarmSound()");
  await flush();
  f.audio().playResult = () => pending.promise;
  f.audio().end();
  await flush();
  const a = f.audio(),
    plays = a.plays;
  f.listeners.get("pagehide")();
  f.listeners.get("pageshow")();
  a.paused = false;
  pending.resolve();
  await flush();
  await f.time.advance(11000);
  assert.equal(a.paused, true);
  assert.equal(a.plays, plays);
  assert.equal(f.time.size, 0);
  assert.equal(f.run("alarmActiveNodes.length"), 0);
});

test("trace records cycle/phase and safe media state, and remains bounded", async () => {
  const f = fixture(),
    run = f.player.playLoop();
  await flush();
  for (let i = 0; i < 100; i++) {
    f.audio.end();
    await flush();
  }
  await run.completion;
  const trace = f.player.getDiagnostics();
  assert.ok(trace.length <= 256);
  assert.ok(trace.some((e) => e.event === "PLAY_RESOLVED"));
  assert.ok(trace.some((e) => e.event === "CYCLE_COMPLETE"));
  assert.ok(
    trace.every((e) => Number.isInteger(e.cycle) && e.operationId === 1),
  );
  assert.ok(
    trace.every((e) => !("src" in e) && !("email" in e) && !("token" in e)),
  );
  f.player.stop();
  assert.equal(f.player.getDiagnostics().at(-1).event, "STOPPED");
  assert.equal(f.player.getDiagnostics().at(-1).paused, true);
});

test("a late-cycle hung play recovers within 750ms without a second live element", async () => {
  const f = fixture(),
    pending = deferred(),
    failures = [],
    recoveries = [];
  const run = f.player.playLoop({
    onFailure: (e) => failures.push(e),
    onRecovery: (e) => recoveries.push(e),
  });
  await flush();
  const retired = f.audio;
  retired.readyState = 0;
  retired.networkState = 2;
  retired.playResult = () => pending.promise;
  retired.end();
  await run.completion;
  await flush();
  await f.time.advance(749);
  assert.equal(f.elements.length, 1);
  await f.time.advance(1);
  const replacement = f.audio;
  assert.notEqual(replacement, retired);
  assert.equal(retired.paused, true);
  assert.equal(retired.src, "");
  assert.equal(replacement.plays, 1);
  assert.equal(f.elements.filter((a) => !a.paused).length, 1);
  retired.paused = false;
  pending.resolve();
  retired.emit("ended");
  retired.emit("pause");
  await flush();
  assert.equal(retired.paused, true);
  assert.equal(replacement.paused, false);
  replacement.end();
  await flush();
  assert.deepEqual(
    recoveries.map((e) => e.recovering),
    [true, false],
  );
  assert.deepEqual(failures, []);
  assert.equal(
    f.player.getDiagnostics().filter((e) => e.event === "RECOVERY_STARTED")
      .length,
    1,
  );
  f.player.stop();
  await f.time.advance(11000);
  assert.equal(f.elements.filter((a) => !a.paused).length, 0);
  assert.equal(f.time.size, 0);
});

test("only consecutive recovery failures exhaust budget; success resets budget", async () => {
  const f = fixture(),
    failures = [];
  const run = f.player.playLoop({ onFailure: (e) => failures.push(e) });
  await flush();
  f.audio.end();
  await run.completion;
  for (let n = 0; n < 3; n++) {
    await f.time.advance(750);
    await flush();
    f.audio.end();
    await flush();
    assert.equal(failures.length, 0);
  }
  await f.time.advance(2250);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].name, "AudioPlaybackStalledError");
  const count = f.elements.length;
  await f.time.advance(11000);
  assert.equal(f.elements.length, count);
  assert.equal(f.time.size, 0);
});

test("native progress with unresolved play Promise does not trigger false recovery", async () => {
  const f = fixture(),
    pending = deferred(),
    failures = [];
  const run = f.player.playLoop({ onFailure: (e) => failures.push(e) });
  await flush();
  f.audio.playResult = () => pending.promise;
  f.audio.end();
  await run.completion;
  for (let tick = 1; tick <= 5; tick++) {
    f.audio.currentTime = tick * 0.25;
    f.audio.emit("timeupdate");
    await f.time.advance(250);
  }
  f.audio.end();
  await flush();
  assert.equal(f.elements.length, 1);
  assert.equal(f.audio.plays, 3);
  assert.deepEqual(failures, []);
  f.player.stop();
  pending.resolve();
  await flush();
});

for (const stopAt of [
  "before-recovery",
  "in-recovery-callback",
  "after-recovery",
]) {
  test(`stop/Abort prevents recovery and late playback: ${stopAt}`, async () => {
    const f = fixture(),
      controller = new AbortController(),
      pending = deferred();
    const run = f.player.playLoop({
      signal: controller.signal,
      onRecovery: () => {
        if (stopAt === "in-recovery-callback") controller.abort();
      },
    });
    await flush();
    const retired = f.audio;
    retired.playResult = () => pending.promise;
    retired.end();
    await run.completion;
    if (stopAt === "before-recovery") controller.abort();
    await f.time.advance(750);
    controller.abort();
    const created = f.elements.length;
    retired.paused = false;
    pending.resolve();
    await flush();
    await f.time.advance(11000);
    assert.equal(f.elements.length, created);
    assert.equal(f.elements.filter((a) => !a.paused).length, 0);
    assert.equal(f.time.size, 0);
  });
}

test("recovery denied by Safari requires gesture without repeated autoplay attempts", async () => {
  const f = fixture(),
    failures = [];
  const run = f.player.playLoop({ onFailure: (e) => failures.push(e) });
  await flush();
  f.audio.end();
  await run.completion;
  await f.time.advance(750);
  f.audio.playResult = () =>
    Promise.reject(Object.assign(new Error(), { name: "NotAllowedError" }));
  f.audio.end();
  await flush();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].name, "NotAllowedError");
  const count = f.elements.length;
  await f.time.advance(11000);
  assert.equal(f.elements.length, count);
});

test("pagehide during automatic recovery never starts again on pageshow", async () => {
  const f = applicationFixture();
  void f.run("startAlarmSound()");
  await flush();
  f.audio().end();
  await flush();
  await f.time.advance(750);
  f.listeners.get("pagehide")();
  f.listeners.get("pageshow")();
  const created = f.elements.length;
  await f.time.advance(11000);
  assert.equal(f.elements.length, created);
  assert.equal(f.elements.filter((a) => !a.paused).length, 0);
  assert.equal(f.run("alarmActiveNodes.length"), 0);
  assert.equal(f.time.size, 0);
});

test("first playing epoch is captured once and survives bounded trace rotation/recovery", async () => {
  const audio = new FakeAudio(),
    starts = [];
  let epoch = 1789911300000;
  const p = htmlAudio.createPlayer({
    createAudio: () => audio,
    wallNow: () => epoch,
  });
  const run = p.playLoop({ onFirstPlayback: (e) => starts.push(e) });
  await flush();
  audio.emit("playing");
  for (let n = 0; n < 100; n++) {
    epoch += 1300;
    audio.end();
    await flush();
    audio.emit("playing");
  }
  assert.equal(starts.length, 1);
  assert.equal(run.getFirstPlayback().epochMilliseconds, 1789911300000);
  assert.ok(
    p.getDiagnostics().every((e) => Number.isFinite(e.epochMilliseconds)),
  );
  p.stop();
});
