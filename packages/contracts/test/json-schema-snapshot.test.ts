import { expect, test } from "vitest";
import { RunStateSchema } from "../src/schemas/run.js";
import { DigestSchema } from "../src/ids.js";
import { ChangeOperationSchema } from "../src/schemas/cloud.js";
import { ApiErrorSchema } from "../src/schemas/http.js";

function stableSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableSchema(item));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (key.startsWith("~")) {
        continue;
      }
      result[key] = stableSchema(record[key]);
    }
    return result;
  }
  return value;
}

test("JSON Schema export snapshots are stable 2020-12 objects", async () => {
  const snapshot = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    RunState: stableSchema(RunStateSchema),
    Digest: stableSchema(DigestSchema),
    ChangeOperation: stableSchema(ChangeOperationSchema),
    ApiError: stableSchema(ApiErrorSchema),
  };
  await expect(snapshot).toMatchFileSnapshot("./fixtures/json-schema/core.snap.json");
});
