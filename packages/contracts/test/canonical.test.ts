import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  CanonicalizationError,
  canonicalize,
  canonicalizeJsonText,
  canonicalizeRfc8785,
  parseCanonicalJsonText,
} from "../src/canonical.js";

const fixtures = path.join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "rfc8785");

function readFixture(name: string): string {
  return readFileSync(path.join(fixtures, name), "utf8")
    .replace(/^\uFEFF/, "")
    .trimEnd();
}

const VECTOR_NAMES = ["arrays", "french", "structures", "unicode", "values", "weird"] as const;

for (const name of VECTOR_NAMES) {
  test(`RFC 8785 official vector ${name} is byte-for-byte`, () => {
    const inputText = readFixture(`${name}.input.json`);
    const expected = readFixture(`${name}.output.json`);
    const parsed = JSON.parse(inputText) as unknown;
    expect(canonicalizeRfc8785(parsed)).toBe(expected);
  });
}

test("RFC 8785 sorting example from the specification", () => {
  const input = {
    "\u20ac": "Euro Sign",
    "\r": "Carriage Return",
    "\ufb33": "Hebrew Letter Dalet With Dagesh",
    "1": "One",
    "\ud83d\ude00": "Emoji: Grinning Face",
    "\u0080": "Control",
    "\u00f6": "Latin Small Letter O With Diaeresis",
  };
  const canonical = canonicalizeRfc8785(input);
  expect(canonical.startsWith("{")).toBe(true);
  expect(canonicalizeRfc8785(JSON.parse(canonical) as unknown)).toBe(canonical);
});

test("contract canonicalizer rejects NaN Infinity unsafe integers cycles and undefined", () => {
  expect(() => canonicalize(Number.NaN)).toThrow(CanonicalizationError);
  expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(CanonicalizationError);
  expect(() => canonicalize(9007199254740992)).toThrow(CanonicalizationError);
  expect(() => canonicalize(undefined)).toThrow(CanonicalizationError);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  expect(() => canonicalize(cyclic)).toThrow(CanonicalizationError);
});

test("duplicate keys in JSON text are rejected", () => {
  expect(() => parseCanonicalJsonText('{"a":1,"a":2}')).toThrow(CanonicalizationError);
  expect(() => canonicalizeJsonText('{"a":1,"b":2}')).not.toThrow();
});

test("unpaired surrogates are rejected", () => {
  expect(() => canonicalize("\uD800")).toThrow(CanonicalizationError);
});
