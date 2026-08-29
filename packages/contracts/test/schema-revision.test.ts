import { expect, test } from "vitest";
import {
  UnknownSchemaRevisionError,
  assertKnownSchemaRevision,
} from "../src/generated/schema-registry.js";

test("unknown schema revision fails closed", () => {
  expect(() => {
    assertKnownSchemaRevision("TaskEnvelope", 1);
  }).not.toThrow();
  expect(() => {
    assertKnownSchemaRevision("TaskEnvelope", 99);
  }).toThrow(UnknownSchemaRevisionError);
  expect(() => {
    assertKnownSchemaRevision("NotASchema", 1);
  }).toThrow(UnknownSchemaRevisionError);
});
