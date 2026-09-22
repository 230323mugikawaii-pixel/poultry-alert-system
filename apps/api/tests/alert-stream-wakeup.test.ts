import { EventEmitter } from "node:events";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import type { AppEnvironment } from "../src/config/env.js";
import { AppError } from "../src/lib/app-error.js";
import { startAlertStream } from "../src/modules/alerts/alert-routes.js";

afterEach(() => vi.useRealTimers());
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function stream(load: () => Promise<{ alerts: never[] }>) {
  const raw = Object.assign(new EventEmitter(), {
    statusCode: 0,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn()
  });
  let wake = () => {};
  const off = vi.fn();
  startAlertStream(
    { log: { error: vi.fn() } } as unknown as FastifyRequest,
    { raw, hijack() {} } as unknown as FastifyReply,
    { PUBLIC_ORIGIN: "https://test.example" } as AppEnvironment,
    (fn) => {
      wake = fn;
      return off;
    },
    load
  );
  return { raw, off, wake: () => wake() };
}

it("wakes out-of-phase OWNER/member streams in the same tick without waiting 5s", async () => {
  vi.useFakeTimers();
  const owner = vi.fn(async () => ({ alerts: [] as never[] }));
  const member = vi.fn(async () => ({ alerts: [] as never[] }));
  const a = stream(owner);
  await flush();
  await vi.advanceTimersByTimeAsync(1388);
  const b = stream(member);
  await flush();
  a.wake();
  b.wake();
  await flush();
  expect(owner).toHaveBeenCalledTimes(2);
  expect(member).toHaveBeenCalledTimes(2);
  expect(a.raw.write.mock.calls.at(-1)).toEqual([": keep-alive\n\n"]);
  expect(b.raw.write.mock.calls.at(-1)).toEqual([": keep-alive\n\n"]);
  a.raw.emit("close");
  b.raw.emit("close");
  expect(vi.getTimerCount()).toBe(0);
});

it("coalesces commit hints during a pending authenticated read without overlap or lost wake", async () => {
  vi.useFakeTimers();
  const pending = deferred<{ alerts: never[] }>();
  const load = vi
    .fn()
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue({ alerts: [] });
  const s = stream(load);
  s.wake();
  s.wake();
  s.wake();
  expect(load).toHaveBeenCalledTimes(1);
  pending.resolve({ alerts: [] });
  await flush();
  expect(load).toHaveBeenCalledTimes(2);
  s.raw.emit("close");
  await vi.advanceTimersByTimeAsync(10000);
  s.wake();
  await flush();
  expect(load).toHaveBeenCalledTimes(2);
  expect(s.off).toHaveBeenCalledTimes(1);
});

it("retains periodic fallback for missed hints and suppresses late writes after disconnect", async () => {
  vi.useFakeTimers();
  const pending = deferred<{ alerts: never[] }>();
  const load = vi
    .fn()
    .mockResolvedValueOnce({ alerts: [] })
    .mockImplementationOnce(() => pending.promise);
  const s = stream(load);
  await flush();
  await vi.advanceTimersByTimeAsync(5000);
  expect(load).toHaveBeenCalledTimes(2);
  const writes = s.raw.write.mock.calls.length;
  s.raw.emit("close");
  pending.resolve({ alerts: [] });
  await flush();
  expect(s.raw.write).toHaveBeenCalledTimes(writes);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([true, false])(
  "reauthenticates hints and cleans up invalid session/transient failure: %s",
  async (ended) => {
    vi.useFakeTimers();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ alerts: [] })
      .mockRejectedValueOnce(
        ended
          ? new AppError("UNAUTHENTICATED", "session ended", 401)
          : new Error("temporary")
      );
    const s = stream(load);
    await flush();
    s.wake();
    await flush();
    expect(s.raw.write.mock.calls.flat().join("")).toContain(
      ended ? "event: session-ended" : "event: stream-error"
    );
    expect(s.raw.end).toHaveBeenCalledTimes(1);
    expect(s.off).toHaveBeenCalledTimes(1);
    s.wake();
    await vi.advanceTimersByTimeAsync(10000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  }
);
