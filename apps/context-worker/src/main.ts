import { handleCompileContext, handleContextFallback } from "./context-handler.js";

export type WorkerPoll = {
  leaseWaitMs: number;
  waitForWork: (timeoutMs: number) => Promise<boolean>;
  onReady?: () => Promise<void>;
};

export async function startContextWorker(input: WorkerPoll): Promise<boolean> {
  const ready = await input.waitForWork(input.leaseWaitMs);
  if (ready && input.onReady !== undefined) {
    await input.onReady();
  }
  return ready;
}

export async function main(input: WorkerPoll): Promise<boolean> {
  return startContextWorker(input);
}

export { handleCompileContext, handleContextFallback };
