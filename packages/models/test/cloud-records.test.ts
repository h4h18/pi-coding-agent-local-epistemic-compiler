import { expect, test } from "vitest";
import { loadCloudCapabilityRecords, recoveryAdapterFor } from "../src/index.js";

test("committed cloud fixtures are Grade C and OpenAI-shaped JSON is not native capability", () => {
  const records = loadCloudCapabilityRecords();
  expect(records.map((item) => item.deploymentId)).toEqual([
    "openai-shaped-unknown",
    "second-provider-grade-c",
  ]);
  const openai = records[0];
  const second = records[1];
  expect(openai?.recovery.grade).toBe("C");
  expect(openai?.recovery.lookupKeyKinds).toEqual([]);
  expect(openai?.tools.supported).toBe("unknown");
  expect(openai?.structuredOutput.jsonSchema).toBe("unknown");
  expect(second?.recovery.grade).toBe("C");
  if (openai === undefined) {
    throw new Error("openai fixture missing");
  }
  const recovery = recoveryAdapterFor(openai);
  expect(recovery.grade).toBe("C");
  expect(recovery.lookupKeys).toEqual([]);
});
