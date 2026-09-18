import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const coordination = require("../js/alert-tab-coordination.js");

class FakeStorage {
  #values = new Map();

  get length() {
    return this.#values.size;
  }

  getItem(key) {
    return this.#values.has(key) ? this.#values.get(key) : null;
  }

  key(index) {
    return Array.from(this.#values.keys())[index] ?? null;
  }

  removeItem(key) {
    this.#values.delete(key);
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }
}

class FakeBroadcastBus {
  #channels = new Map();

  create(name) {
    const listeners = new Set();
    const channel = {
      addEventListener: (_type, listener) => listeners.add(listener),
      close: () => this.#channels.get(name)?.delete(channel),
      postMessage: (data) => {
        this.#channels.get(name)?.forEach((target) => {
          target.listeners.forEach((listener) => listener({ data }));
        });
      },
      removeEventListener: (_type, listener) => listeners.delete(listener),
      listeners,
    };
    const channels = this.#channels.get(name) || new Set();
    channels.add(channel);
    this.#channels.set(name, channels);
    return channel;
  }
}

class FakeLockManager {
  #queues = new Map();

  request(name, _options, callback) {
    const previous = this.#queues.get(name) || Promise.resolve();
    const current = previous.then(() => callback({ name }));
    this.#queues.set(name, current.catch(() => undefined));
    return current;
  }
}

function coordinator({
  storage,
  bus,
  tabId,
  lockManager = null,
  now = () => Date.parse("2026-09-18T00:00:00.000Z"),
}) {
  return coordination.createCoordinator({
    storage,
    createChannel: (name) => bus.create(name),
    tabId,
    lockManager,
    now,
    electionDelayMs: 1,
    wait: () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
}

test("one browser grants one tab the presentation right", async () => {
  const storage = new FakeStorage();
  const bus = new FakeBroadcastBus();
  const first = coordinator({ storage, bus, tabId: "tab-a" });
  const second = coordinator({ storage, bus, tabId: "tab-b" });

  const claims = await Promise.all([
    first.claimPresentation("alert-1"),
    second.claimPresentation("alert-1"),
  ]);

  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(first.hasHandled("alert-1"), true);
  assert.equal(second.hasHandled("alert-1"), true);
});

test("Web Locks serializes simultaneous presentation claims", async () => {
  const storage = new FakeStorage();
  const bus = new FakeBroadcastBus();
  const lockManager = new FakeLockManager();
  const first = coordinator({ storage, bus, tabId: "tab-a", lockManager });
  const second = coordinator({ storage, bus, tabId: "tab-b", lockManager });

  const claims = await Promise.all([
    first.claimPresentation("alert-2"),
    second.claimPresentation("alert-2"),
  ]);

  assert.deepEqual(claims.sort(), [false, true]);
});

test("stopping one tab propagates STOPPED to the other tabs", async () => {
  let now = Date.parse("2026-09-18T00:00:00.000Z");
  const storage = new FakeStorage();
  const bus = new FakeBroadcastBus();
  const first = coordinator({ storage, bus, tabId: "tab-a", now: () => now });
  const second = coordinator({ storage, bus, tabId: "tab-b", now: () => now });
  const received = [];
  second.subscribe((record) => received.push(record));

  assert.equal(await first.claimPresentation("alert-3"), true);
  now += 1;
  first.stop("alert-3");

  assert.equal(received.at(-1)?.state, "STOPPED");
  assert.equal(received.at(-1)?.id, "alert-3");
});

test("reload and a new tab do not reclaim a handled alert", async () => {
  const storage = new FakeStorage();
  const bus = new FakeBroadcastBus();
  const first = coordinator({ storage, bus, tabId: "tab-a" });
  assert.equal(await first.claimPresentation("alert-4"), true);
  first.stop("alert-4");
  first.dispose();

  const reloaded = coordinator({ storage, bus, tabId: "tab-reloaded" });
  assert.equal(reloaded.hasHandled("alert-4"), true);
  assert.equal(await reloaded.claimPresentation("alert-4"), false);
});

test("a separate browser storage remains independent", async () => {
  const first = coordinator({
    storage: new FakeStorage(),
    bus: new FakeBroadcastBus(),
    tabId: "device-a",
  });
  const second = coordinator({
    storage: new FakeStorage(),
    bus: new FakeBroadcastBus(),
    tabId: "device-b",
  });

  assert.equal(await first.claimPresentation("alert-5"), true);
  assert.equal(await second.claimPresentation("alert-5"), true);
});

test("startup suppresses old TEST alerts but permits unseen REAL alerts", () => {
  const pageStartedAt = Date.parse("2026-09-18T00:10:00.000Z");
  const base = {
    id: "alert-6",
    status: "ACTIVE",
    readAt: null,
    dismissedAt: null,
  };

  assert.equal(
    coordination.shouldPresentAlert(
      { ...base, kind: "TEST", detectedAt: "2026-09-18T00:09:59.000Z" },
      pageStartedAt,
    ),
    false,
  );
  assert.equal(
    coordination.shouldPresentAlert(
      { ...base, kind: "TEST", detectedAt: "2026-09-18T00:10:01.000Z" },
      pageStartedAt,
    ),
    true,
  );
  assert.equal(
    coordination.shouldPresentAlert(
      { ...base, kind: "REAL", detectedAt: "2026-09-17T23:00:00.000Z" },
      pageStartedAt,
    ),
    true,
  );
  assert.equal(
    coordination.shouldPresentAlert(
      { ...base, kind: "REAL", readAt: "2026-09-18T00:00:00.000Z" },
      pageStartedAt,
    ),
    false,
  );
});
