import type { MaybePromise } from "@pi-hec/contracts";
import { materializeCandidate } from "./materialize-handler.js";
import { verifyCandidate } from "./verify-handler.js";

export type WorkerPoll = {
  leaseWaitMs: number;
  waitForWork: (timeoutMs: number) => MaybePromise<boolean>;
  onReady?: () => Promise<void>;
};

export async function startVerificationWorker(input: WorkerPoll): Promise<boolean> {
  const ready = await input.waitForWork(input.leaseWaitMs);
  if (ready && input.onReady !== undefined) {
    await input.onReady();
  }
  return ready;
}

export async function main(input: WorkerPoll): Promise<boolean> {
  return startVerificationWorker(input);
}

export { materializeCandidate, verifyCandidate };
