import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import alarmAudio from "../js/alarm-audio.js";

const source = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
function applicationFunction(name) {
  const match = source.match(
    new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}$`, "m"),
  );
  assert.ok(match, `production function ${name} exists`);
  return match[0];
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const paint = deferred();
  const claim = deferred();
  const listeners = new Map();
  const metrics = {
    patterns: 0,
    shown: 0,
    contextRequests: 0,
    preferences: [],
    failures: [],
  };
  const context = { state: "running", resume: async () => {} };
  const element = {
    classList: { contains: () => false },
    addEventListener() {},
  };
  const scope = vm.createContext({
    AbortController,
    DOMException,
    console: { info() {} },
    window: {
      addEventListener: (name, callback) => listeners.set(name, callback),
      clearTimeout,
    },
    document: { getElementById: () => element, addEventListener() {} },
    alarmAudioPolicy: {
      ...alarmAudio,
      resumeAudioContext: (audio, options) =>
        alarmAudio.resumeAudioContext(audio, {
          ...options,
          timeoutMilliseconds: 5,
        }),
    },
    waitForAlarmModalPaint: () => paint.promise,
    getAlarmAudioContext: () => {
      metrics.contextRequests += 1;
      return context;
    },
    playAlarmPattern: async () => {
      metrics.patterns += 1;
    },
    showAlarmNotification: () => {
      metrics.shown += 1;
    },
    failActiveAlarmPlayback: (error) => {
      metrics.failures.push(error.name);
      vm.runInContext(
        'stopAlarmSound(); alarmPlaybackState = "BLOCKED";',
        scope,
      );
    },
    recordAlarmAudioFailure: (error) => metrics.failures.push(error.name),
    saveAlarmSoundPreference: (enabled) => metrics.preferences.push(enabled),
    updateAllAlarmSoundControls() {},
    setAlarmModalSoundStatus() {},
    recordAlertPresentationEvent() {},
    updateAlarmModalSoundStatus() {},
    stopCurrentAlarmLocally() {},
    handleAlarmModalKeydown() {},
    handleExternalAlertPresentation() {},
    closeAlarmNotification() {},
    showAlarmAudioFallback() {},
    alertTabCoordinator: {
      claimPresentation: () => claim.promise,
      subscribe() {},
    },
  });
  vm.runInContext(
    `
    let alarmPageActive = true;
    const ALARM_AUDIO_BACKEND = "web-audio";
    let alarmHtmlAudio = null;
    let alarmEnableAfterPlayback = false;
    let alarmPlaybackGeneration = 0;
    let alarmAudioAbortController = new AbortController();
    let alarmSoundEnabled = true;
    let alarmIsActive = false;
    let alarmPlaybackState = "IDLE";
    let alarmPlaybackCycleCount = 0;
    let alarmRepeatTimer = null;
    let alarmActiveNodes = [];
    let alarmAudioResumeInProgress = false;
    let alarmAudioVerificationState = "UNVERIFIED";
    let alarmSoundError = "";
    let alarmAudioLastFailure = null;
    const currentAlarmAlertContext = { alertId: "fixture-alert", audience: "OWNER" };
    const ownerAlerts = [{ id: "fixture-alert", status: "ACTIVE", readAt: null }];
    const notificationMemberAlerts = [];
    const notifiedAlertIds = new Set();
    const pendingAlertPresentationIds = new Set();
    ${["initializeAlarmNotification", "stopAlarmSound", "startAlarmAfterModalPresentation", "coordinateAlertPresentation", "startAlarmSound", "unlockAlarmAudio", "enableAlarmAudio", "enableAlarmSoundForCurrentAlert"].map(applicationFunction).join("\n")}
    initializeAlarmNotification();
  `,
    scope,
  );
  return {
    paint,
    claim,
    listeners,
    metrics,
    context,
    run: (code) => vm.runInContext(code, scope),
  };
}

for (const restored of [false, true]) {
  test(`pagehide cancels pending modal paint, including restoration=${restored}`, async () => {
    const f = fixture();
    const pending = f.run(
      "startAlarmAfterModalPresentation(currentAlarmAlertContext)",
    );
    f.listeners.get("pagehide")({ persisted: true });
    if (restored) f.listeners.get("pageshow")?.({ persisted: true });
    f.paint.resolve();
    await pending;
    assert.equal(f.metrics.contextRequests, 0);
    assert.equal(f.metrics.patterns, 0);
    assert.equal(f.run("alarmPlaybackState"), "STOPPED");
  });
}

test("pagehide invalidates pending cross-tab presentation claims", async () => {
  const f = fixture();
  const pending = f.run(
    'coordinateAlertPresentation(ownerAlerts[0], "OWNER", currentAlarmAlertContext)',
  );
  f.listeners.get("pagehide")({ persisted: true });
  f.listeners.get("pageshow")?.({ persisted: true });
  f.claim.resolve(true);
  await pending;
  assert.equal(f.metrics.shown, 0);
});

test("a hidden lifecycle cannot start audio, while a fresh restored action can", async () => {
  const f = fixture();
  f.listeners.get("pagehide")({ persisted: true });
  await f.run("startAlarmSound()");
  assert.equal(f.metrics.contextRequests, 0);
  f.listeners.get("pageshow")?.({ persisted: true });
  await f.run("startAlarmSound()");
  assert.equal(f.metrics.patterns, 1);
});

test("stop during resume prevents late completion from scheduling an alarm", async () => {
  const f = fixture();
  const resume = deferred();
  f.context.state = "suspended";
  f.context.resume = () => resume.promise;
  const pending = f.run("startAlarmSound()");
  f.listeners.get("pagehide")({ persisted: true });
  f.context.state = "running";
  resume.resolve();
  await pending;
  assert.equal(f.metrics.patterns, 0);
  assert.deepEqual(f.metrics.failures, []);
});

test("resume timeout blocks playback and a late resolve cannot restart it", async () => {
  const f = fixture();
  const resume = deferred();
  f.context.state = "suspended";
  f.context.resume = () => resume.promise;
  const pending = f.run("startAlarmSound()");
  await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(resolve, 30)),
  ]);
  const beforeLateResolve = f.run("alarmPlaybackState");
  f.context.state = "running";
  resume.resolve();
  await pending;
  assert.equal(beforeLateResolve, "BLOCKED");
  assert.deepEqual(f.metrics.failures, ["AudioPlaybackTimeoutError"]);
  assert.equal(f.metrics.patterns, 0);
});

test("late explicit enablement after pagehide cannot save ON or play confirmation", async () => {
  const f = fixture();
  const resume = deferred();
  f.context.state = "suspended";
  f.context.resume = () => resume.promise;
  const pending = f.run('enableAlarmAudio("OWNER")');
  f.listeners.get("pagehide")({ persisted: true });
  f.listeners.get("pageshow")?.({ persisted: true });
  f.context.state = "running";
  resume.resolve();
  assert.equal(await pending, false);
  assert.deepEqual(f.metrics.preferences, []);
  assert.deepEqual(f.metrics.failures, []);
});
