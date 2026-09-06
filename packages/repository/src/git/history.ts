import {
  objectDigestFromBytes,
  type GitHistoryManifest,
  type ObjectDigest,
  type SnapshotId,
} from "@pi-hec/contracts";
import { evidenceIdFromNode } from "../ingestion/evidence-id.js";
import { interfaceFingerprint } from "../ingestion/revision.js";
import { decodeUtf8 } from "../ingestion/text.js";
import type { BlobGetter, GraphEdgeRecord, IndexUnit } from "../ingestion/types.js";

export async function gitUnitsAndEdges(
  history: GitHistoryManifest,
  snapshotId: SnapshotId,
  getBlob: BlobGetter,
): Promise<{ units: IndexUnit[]; edges: GraphEdgeRecord[]; cochange: Map<string, number> }> {
  const units: IndexUnit[] = [];
  const edges: GraphEdgeRecord[] = [];
  const cochange = new Map<string, number>();
  for (const commit of history.commits) {
    const patchDigest = commit.patchArtifactObjectDigest;
    if (patchDigest !== undefined) {
      if (!patchDigest.startsWith("sha256:")) {
        throw new Error("patchArtifactObjectDigest must be a sha256 object digest");
      }
      const bytes = await getBlob(patchDigest as ObjectDigest);
      const text = decodeUtf8(bytes) ?? Buffer.from(bytes).toString("utf8");
      const contentDigest = objectDigestFromBytes(bytes);
      const identityKey = `diff:${commit.objectId}`.slice(0, 1024);
      const evidenceId = evidenceIdFromNode({
        snapshotId,
        kind: "diff-hunk",
        identityKey,
        contentObjectDigest: contentDigest,
        provenanceIdentities: [`git:${commit.objectId}`],
      });
      units.push({
        evidenceId,
        path: `.git/commits/${commit.objectId}.diff`,
        kind: "diff",
        parentHierarchy: [".git", commit.objectId],
        byteStart: 0,
        byteEnd: bytes.byteLength,
        lineStart: 1,
        lineEnd: Math.max(1, text.split("\n").length),
        contentDigest,
        language: "diff",
        symbolId: commit.objectId,
        imports: commit.parentObjectIds,
        exports: commit.changedPaths,
        snapshotId,
        text,
        producer: "pi-hec-git-history/v1",
        interfaceFingerprint: interfaceFingerprint(commit.parentObjectIds, commit.changedPaths),
      });
    } else {
      const identityKey = `commit:${commit.objectId}`.slice(0, 1024);
      const digest = commit.messageDigest as ObjectDigest;
      const evidenceId = evidenceIdFromNode({
        snapshotId,
        kind: "commit",
        identityKey,
        contentObjectDigest: digest,
        provenanceIdentities: [`git:${commit.objectId}`],
      });
      units.push({
        evidenceId,
        path: `.git/commits/${commit.objectId}`,
        kind: "commit",
        parentHierarchy: [".git"],
        byteStart: 0,
        byteEnd: 1,
        lineStart: 1,
        lineEnd: 1,
        contentDigest: digest,
        language: "git",
        symbolId: commit.objectId,
        imports: commit.parentObjectIds,
        exports: commit.changedPaths,
        snapshotId,
        text: [commit.objectId, digest, ...commit.changedPaths].join("\n"),
        producer: "pi-hec-git-history/v1",
        interfaceFingerprint: interfaceFingerprint(commit.parentObjectIds, commit.changedPaths),
      });
    }
    const paths = [...commit.changedPaths].sort();
    for (let i = 0; i < paths.length; i += 1) {
      const left = paths[i];
      if (left === undefined) {
        continue;
      }
      for (let j = i + 1; j < paths.length; j += 1) {
        const right = paths[j];
        if (right === undefined) {
          continue;
        }
        const key = `${left}\0${right}`;
        cochange.set(key, (cochange.get(key) ?? 0) + 1);
      }
    }
  }
  return { units, edges, cochange };
}
