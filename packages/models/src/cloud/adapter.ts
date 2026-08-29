import { type DeploymentCapabilities } from "@pi-hec/contracts";
import type { CloudRecoveryAdapter, GradeACloudRecoveryLookupKey, GradeBCloudRecoveryLookupKey } from "./types.js";

export function recoveryAdapterFor(
  capabilities: DeploymentCapabilities,
  lookup?: CloudRecoveryAdapter,
): CloudRecoveryAdapter {
  const recovery = capabilities.recovery;
  switch (recovery.grade) {
    case "A": {
      if (lookup !== undefined && lookup.grade === "A") {
        return lookup;
      }
      const first = recovery.lookupKeyKinds[0];
      if (first === undefined) {
        throw new Error("grade A recovery requires lookupKeyKinds");
      }
      return {
        grade: "A",
        lookupKeys: [first, ...recovery.lookupKeyKinds.slice(1)],
        lookup: (key: GradeACloudRecoveryLookupKey) => {
          void key;
          return Promise.resolve({
            state: "unknown" as const,
            reasonCode: "NO_COMMITTED_TRANSCRIPT",
          });
        },
      };
    }
    case "B":
      if (lookup !== undefined && lookup.grade === "B") {
        return lookup;
      }
      return {
        grade: "B",
        lookupKeys: ["provider-operation-id"],
        lookup: (key: GradeBCloudRecoveryLookupKey) => {
          void key;
          return Promise.resolve({
            state: "unknown" as const,
            reasonCode: "NO_DURABLE_OPERATION_ID",
          });
        },
      };
    case "C":
      return { grade: "C", lookupKeys: [] };
    default: {
      const exhaustive: never = recovery;
      throw new Error(`unhandled recovery ${String(exhaustive)}`);
    }
  }
}

export async function postOnce(input: {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
  maxRetries: 0;
}): Promise<Response> {
  const retries: number = input.maxRetries;
  if (retries !== 0) {
    throw new Error("cloud postOnce forbids retries");
  }
  return input.fetchImpl(input.url, {
    method: "POST",
    headers: input.headers,
    body: input.body,
    signal: input.signal,
  });
}
