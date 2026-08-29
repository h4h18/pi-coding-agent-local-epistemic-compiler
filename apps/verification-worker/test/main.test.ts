import { expect, test } from "vitest";
import { materializeCandidate } from "../src/materialize-handler.js";
import { verifyCandidate } from "../src/verify-handler.js";
import { startVerificationWorker } from "../src/main.js";

test("verification-worker main exports real handlers and polls waitForWork", async () => {
  expect(typeof materializeCandidate).toBe("function");
  expect(typeof verifyCandidate).toBe("function");
  let polled = false;
  const ready = await startVerificationWorker({
    leaseWaitMs: 5,
    waitForWork: async () => {
      polled = true;
      return false;
    },
  });
  expect(polled).toBe(true);
  expect(ready).toBe(false);
});
