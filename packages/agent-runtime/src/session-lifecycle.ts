import type { SpawnRequest } from "@pi-hec/contracts";
import type { AgentHandle, AgentResult, AgentRuntime, HeadlessSession } from "./types.js";

export const SESSION_ABORT_TIMEOUT_MS = 2_000;
export const DEFAULT_CONSUME_TIMEOUT_MS = 15 * 60 * 1000;
export const STOP_BEST_EFFORT_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function abortAndDispose(
  session: HeadlessSession,
  timeoutMs: number = SESSION_ABORT_TIMEOUT_MS,
): Promise<void> {
  await Promise.race([session.abort().catch(() => undefined), delay(timeoutMs)]);
  session.dispose();
}

async function stopBestEffort(
  runtime: AgentRuntime,
  handle: AgentHandle | undefined,
  timeoutMs: number = STOP_BEST_EFFORT_MS,
): Promise<void> {
  const stopping = handle === undefined ? runtime.stopAll() : runtime.stop(handle);
  await Promise.race([stopping.catch(() => undefined), delay(timeoutMs)]);
}

export async function consumeWithTimeout(
  runtime: AgentRuntime,
  handle: AgentHandle,
  timeoutMs: number = DEFAULT_CONSUME_TIMEOUT_MS,
): Promise<AgentResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error("consume timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([runtime.consume(handle), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (timedOut) {
      void (handle === undefined ? runtime.stopAll() : runtime.stop(handle)).catch(() => undefined);
    } else {
      await stopBestEffort(runtime, handle);
    }
  }
}

export async function runTimedAgentTurn(
  runtime: AgentRuntime,
  spawn: SpawnRequest,
  timeoutMs: number = DEFAULT_CONSUME_TIMEOUT_MS,
): Promise<{ handle: AgentHandle; result: AgentResult }> {
  let handle: AgentHandle | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error("consume timeout"));
    }, timeoutMs);
  });
  try {
    const work = (async () => {
      handle = await runtime.spawn(spawn);
      const result = await runtime.consume(handle);
      return { handle, result };
    })();
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (timedOut) {
      void (handle === undefined ? runtime.stopAll() : runtime.stop(handle)).catch(() => undefined);
    } else {
      await stopBestEffort(runtime, handle);
    }
  }
}

export async function consumeThenStop(
  runtime: AgentRuntime,
  handle: AgentHandle,
): Promise<AgentResult> {
  try {
    return await runtime.consume(handle);
  } finally {
    await stopBestEffort(runtime, handle);
  }
}
