import { sha256Utf8 } from "@pi-hec/contracts";

export type FailureFingerprint = {
  digest: string;
  cycle: number;
};

export function failureFingerprint(input: {
  nodeId: string;
  findingIds: readonly string[];
  exitCodes: readonly number[];
}): string {
  return sha256Utf8(
    `${input.nodeId}|${[...input.findingIds].sort().join(",")}|${input.exitCodes.join(",")}`,
  );
}

export function shouldChangeStrategy(
  history: readonly FailureFingerprint[],
  nextDigest: string,
): boolean {
  const lastTwo = history.slice(-2);
  return lastTwo.length === 2 && lastTwo.every((item) => item.digest === nextDigest);
}
