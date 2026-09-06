import { expect, test } from "vitest";
import { attempt, type MaybePromise } from "../src/async.js";

test("attempt wraps a synchronous result in a promise", async () => {
  const result = attempt(() => 42);
  expect(result).toBeInstanceOf(Promise);
  await expect(result).resolves.toBe(42);
});

test("attempt adopts an asynchronous result without double wrapping", async () => {
  const inner = Promise.resolve("done");
  const result = attempt(() => inner);
  expect(result).toBeInstanceOf(Promise);
  await expect(result).resolves.toBe("done");
});

test("attempt turns a synchronous throw into a rejection", async () => {
  const failure = new Error("sync boom");
  const result = attempt((): number => {
    throw failure;
  });
  await expect(result).rejects.toBe(failure);
});

test("attempt propagates an asynchronous rejection", async () => {
  const failure = new Error("async boom");
  await expect(attempt(() => Promise.reject(failure))).rejects.toBe(failure);
});

test("attempt invokes the work synchronously, before the returned promise settles", async () => {
  const order: string[] = [];
  const pending = attempt(() => {
    order.push("work");
    return "value";
  });
  order.push("after-call");
  await pending;
  order.push("after-await");
  expect(order).toEqual(["work", "after-call", "after-await"]);
});

test("attempt accepts implementations of MaybePromise ports interchangeably", async () => {
  type Port = { read: () => MaybePromise<number> };
  const syncPort: Port = { read: () => 1 };
  const asyncPort: Port = { read: () => Promise.resolve(2) };
  const values = await Promise.all([attempt(syncPort.read), attempt(asyncPort.read)]);
  expect(values).toEqual([1, 2]);
});
