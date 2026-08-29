import { assert, property, json } from "fast-check";
import { expect, test } from "vitest";
import { canonicalize } from "../src/canonical.js";
import { payloadDigest } from "../src/digest.js";
import { type JsonValue } from "../src/ids.js";

function asContractJson(value: unknown): JsonValue | undefined {
  try {
    canonicalize(value);
    return value as JsonValue;
  } catch {
    return undefined;
  }
}

test("property: canonicalize then parse preserves payload digest", () => {
  assert(
    property(json(), (value) => {
      const contract = asContractJson(value);
      if (contract === undefined) {
        return true;
      }
      const first = payloadDigest({
        schemaName: "TaskEnvelope",
        schemaVersion: 1,
        payload: contract,
      });
      const roundTrip = JSON.parse(canonicalize(contract)) as JsonValue;
      const second = payloadDigest({
        schemaName: "TaskEnvelope",
        schemaVersion: 1,
        payload: roundTrip,
      });
      expect(second).toBe(first);
      return true;
    }),
    { numRuns: 64 },
  );
});
