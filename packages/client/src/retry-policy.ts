import type { ApiOperationClass } from "@pi-hec/contracts";

export type RetryDecisionInput = {
  operationClass: ApiOperationClass;
  attempt: number;
  maxAttempts: number;
  error:
    | { kind: "network" }
    | { kind: "status"; status: number; retryClass?: "never" | "safe" | "ambiguous" | "after-user-action" };
};

export const DEFAULT_READ_MAX_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 50;
export const RETRY_MAX_DELAY_MS = 1000;

export function shouldRetry(input: RetryDecisionInput): boolean {
  if (input.operationClass !== "read") {
    return false;
  }
  if (input.attempt >= input.maxAttempts) {
    return false;
  }
  if (input.error.kind === "network") {
    return true;
  }
  if (input.error.status === 503 && input.error.retryClass !== "never") {
    return true;
  }
  return false;
}

export function retryDelayMs(attempt: number): number {
  const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
  return delay > RETRY_MAX_DELAY_MS ? RETRY_MAX_DELAY_MS : delay;
}

export async function sleep(ms: number, wait: (ms: number) => Promise<void> = defaultWait): Promise<void> {
  await wait(ms);
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
