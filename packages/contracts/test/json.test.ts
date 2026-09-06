import { assert, json, property } from "fast-check";
import { expect, test } from "vitest";
import { canonicalizeRfc8785 } from "../src/canonical.js";
import { JsonConversionError, isJsonObject, toJsonObject, toJsonValue } from "../src/json.js";

test("toJsonValue returns primitives and structurally copies containers", () => {
  expect(toJsonValue(null)).toBeNull();
  expect(toJsonValue(true)).toBe(true);
  expect(toJsonValue(0)).toBe(0);
  expect(toJsonValue("text")).toBe("text");

  const source = { b: [1, "two", { c: null }], a: { nested: false } };
  const converted = toJsonValue(source);
  expect(converted).toEqual(source);
  expect(converted).not.toBe(source);
  if (converted === null || typeof converted !== "object" || Array.isArray(converted)) {
    throw new Error("expected object");
  }
  expect(converted.b).not.toBe(source.b);
  expect(converted.a).not.toBe(source.a);
});

test("toJsonValue is a fixed point on arbitrary JSON and preserves the RFC 8785 form", () => {
  assert(
    property(json(), (value) => {
      const converted = toJsonValue(value);
      expect(converted).toEqual(value);
      expect(canonicalizeRfc8785(converted)).toBe(canonicalizeRfc8785(value));
    }),
    { numRuns: 300 },
  );
});

test("toJsonValue converts branded strings and class instances by their own enumerable data", () => {
  class Envelope {
    readonly schemaName = "Envelope";
    readonly payload = { count: 2 };
    describe(): string {
      return this.schemaName;
    }
  }
  expect(toJsonValue(new Envelope())).toEqual({ schemaName: "Envelope", payload: { count: 2 } });
  expect(toJsonValue(Object.create(null))).toEqual({});
});

test("toJsonValue never silently drops or coerces non-JSON input", () => {
  const cases: readonly [unknown, string][] = [
    [undefined, "value of type undefined is not JSON"],
    [{ region: undefined }, "value of type undefined is not JSON"],
    [[1, undefined], "value of type undefined is not JSON"],
    [Number.NaN, "non-finite number is not JSON"],
    [Number.POSITIVE_INFINITY, "non-finite number is not JSON"],
    [{ ratio: Number.NEGATIVE_INFINITY }, "non-finite number is not JSON"],
    [10n, "value of type bigint is not JSON"],
    [Symbol("s"), "value of type symbol is not JSON"],
    [() => 1, "value of type function is not JSON"],
    [{ run: () => 1 }, "value of type function is not JSON"],
  ];
  for (const [input, message] of cases) {
    let caught: unknown;
    try {
      toJsonValue(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JsonConversionError);
    if (caught instanceof JsonConversionError) {
      expect(caught.name).toBe("JsonConversionError");
      expect(caught.message).toBe(message);
    }
  }
});

test("toJsonValue rejects cyclic structures instead of overflowing the stack", () => {
  const cyclic: { self?: unknown; list: unknown[] } = { list: [] };
  cyclic.self = cyclic;
  expect(() => toJsonValue(cyclic)).toThrow(
    new JsonConversionError("cyclic structure is not JSON"),
  );

  const ring: unknown[] = [];
  ring.push({ ring });
  expect(() => toJsonValue(ring)).toThrow(JsonConversionError);

  const shared = { leaf: true };
  expect(toJsonValue({ left: shared, right: shared, list: [shared, shared] })).toEqual({
    left: { leaf: true },
    right: { leaf: true },
    list: [{ leaf: true }, { leaf: true }],
  });
});

test("isJsonObject narrows to plain objects only", () => {
  expect(isJsonObject({})).toBe(true);
  expect(isJsonObject({ a: 1 })).toBe(true);
  expect(isJsonObject([])).toBe(false);
  expect(isJsonObject(null)).toBe(false);
  expect(isJsonObject(undefined)).toBe(false);
  expect(isJsonObject("{}")).toBe(false);
  expect(isJsonObject(1)).toBe(false);
  expect(isJsonObject(true)).toBe(false);
});

test("toJsonObject accepts objects and rejects every other JSON shape", () => {
  const converted = toJsonObject({ a: [1, 2], b: "x" });
  expect(converted).toEqual({ a: [1, 2], b: "x" });
  expect({ ...converted, extra: true }).toEqual({ a: [1, 2], b: "x", extra: true });

  for (const input of [null, [], [{ a: 1 }], "text", 1, false]) {
    expect(() => toJsonObject(input)).toThrow(
      new JsonConversionError("value is not a JSON object"),
    );
  }
  expect(() => toJsonObject({ bad: undefined })).toThrow(
    new JsonConversionError("value of type undefined is not JSON"),
  );
});
