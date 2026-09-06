import { createHash } from "node:crypto";
import { canonicalizeRfc8785, objectDigestFromBytes, type ObjectDigest } from "@pi-hec/contracts";
import { pinnedGrammarDigests } from "../graph/pinned-grammars.js";
import { INDEX_TOOLCHAIN } from "./types.js";

export function toolchainDigest(): ObjectDigest {
  return objectDigestFromBytes(
    Buffer.from(
      canonicalizeRfc8785({
        ...INDEX_TOOLCHAIN,
        pinnedGrammars: pinnedGrammarDigests(),
      }),
      "utf8",
    ),
  );
}

export function indexRevisionDigest(input: {
  snapshotId: string;
  snapshotRootDigest: string;
  toolchainDigest: ObjectDigest;
  gitHistoryRootDigest: string | undefined;
}): ObjectDigest {
  return objectDigestFromBytes(
    Buffer.from(
      canonicalizeRfc8785({
        snapshotId: input.snapshotId,
        snapshotRootDigest: input.snapshotRootDigest,
        toolchainDigest: input.toolchainDigest,
        gitHistoryRootDigest: input.gitHistoryRootDigest ?? null,
      }),
      "utf8",
    ),
  );
}

export function interfaceFingerprint(
  imports: readonly string[],
  exports: readonly string[],
): string {
  const canonical = canonicalizeRfc8785({
    imports: [...imports].sort(),
    exports: [...exports].sort(),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
