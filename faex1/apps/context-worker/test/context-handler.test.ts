import { expect, test } from "vitest";
import { compileCloudContext } from "@pi-hec/context-compiler";
import { handleCompileContext, handleContextFallback } from "../src/context-handler.js";
import { startContextWorker } from "../src/main.js";

test("context-handler re-exports compile and fallback without a second apply path", () => {
  expect(handleCompileContext).toBe(compileCloudContext);
  expect(typeof handleContextFallback).toBe("function");
  expect(handleContextFallback.name.length).toBeGreaterThan(0);
});

test("context-worker main polls waitForWork and does not steal leases", async () => {
  let polled = false;
  const ready = await startContextWorker({
    leaseWaitMs: 5,
    waitForWork: () => {
      polled = true;
      return false;
    },
  });
  expect(polled).toBe(true);
  expect(ready).toBe(false);
});
