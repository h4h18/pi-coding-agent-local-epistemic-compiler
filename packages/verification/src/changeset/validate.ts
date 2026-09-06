import { Compile } from "typebox/compile";
import {
  ChangeSetSchema,
  type ChangeSet,
  type Digest,
  type DomainDigest,
  type SnapshotId,
} from "@pi-hec/contracts";
import { computeNormalizedChangeSetDigest } from "@pi-hec/domain";
import { candidateTreeDigest, type CandidateEntry } from "@pi-hec/repository";
import { applyOperation } from "./apply.js";
import { assertCanonicalChains, declaredPaths } from "./chains.js";
import { ChangeSetError } from "./errors.js";
import {
  EphemeralTree,
  snapshotFingerprint,
  type BaselineEntry,
  type BaselineFilesystem,
} from "./tree.js";

const CHANGESET = Compile(ChangeSetSchema);
const MAX_OPERATIONS = 8192;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;

export type ChangeSetBaseline = {
  snapshotId: SnapshotId;
  rootDigest: Digest;
  filesystem: BaselineFilesystem;
  entries: readonly BaselineEntry[];
};

export type AppliedCandidateTree = {
  changeSet: ChangeSet;
  normalizedChangeSetDigest: DomainDigest<"changeset-normalized">;
  materializedTreeDigest: DomainDigest<"candidate-tree">;
  changedPaths: readonly string[];
  entries: readonly CandidateEntry[];
};

function decodedBytes(changeSet: ChangeSet): number {
  let total = 0;
  for (const operation of changeSet.operations) {
    switch (operation.kind) {
      case "text_patch":
        total += Buffer.byteLength(operation.unifiedDiff, "utf8");
        break;
      case "create_text":
        total += Buffer.byteLength(operation.content, "utf8");
        break;
      case "write_binary":
        total += Buffer.from(operation.base64Content, "base64").byteLength;
        break;
      case "create_directory":
      case "delete":
      case "delete_directory":
      case "move":
      case "set_git_mode":
      case "symlink":
        break;
      default: {
        const exhaustive: never = operation;
        throw new ChangeSetError(
          "UNHANDLED_OPERATION",
          `unhandled union: ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }
  return total;
}

function assertDeclaredMutations(
  before: Map<string, string>,
  after: Map<string, string>,
  declared: Set<string>,
): string[] {
  const changed: string[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of paths) {
    if (before.get(path) === after.get(path)) {
      continue;
    }
    if (!declared.has(path)) {
      throw new ChangeSetError("UNDECLARED_MUTATION", `undeclared mutation at ${path}`);
    }
    changed.push(path);
  }
  changed.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return changed;
}

export function validateAndApplyChangeSet(input: {
  changeSet: unknown;
  baseline: ChangeSetBaseline;
}): AppliedCandidateTree {
  if (!CHANGESET.Check(input.changeSet)) {
    throw new ChangeSetError("SCHEMA_INVALID", "ChangeSet schema invalid");
  }
  const changeSet = input.changeSet;
  if (changeSet.operations.length === 0) {
    throw new ChangeSetError("EMPTY_OPERATIONS", "ChangeSet.operations must be non-empty");
  }
  if (changeSet.operations.length > MAX_OPERATIONS || decodedBytes(changeSet) > MAX_DECODED_BYTES) {
    throw new ChangeSetError("RESOURCE_LIMIT", "ChangeSet exceeds safety limits");
  }
  if (changeSet.baseSnapshotId !== input.baseline.snapshotId) {
    throw new ChangeSetError("BASE_SNAPSHOT_MISMATCH", "baseSnapshotId does not match baseline");
  }
  if (changeSet.baseSnapshotRootDigest !== input.baseline.rootDigest) {
    throw new ChangeSetError(
      "BASE_SNAPSHOT_MISMATCH",
      "baseSnapshotRootDigest does not match baseline",
    );
  }
  const tree = new EphemeralTree(input.baseline.filesystem, input.baseline.entries);
  const before = new Map<string, string>();
  for (const node of tree.list()) {
    before.set(node.path, JSON.stringify(snapshotFingerprint(node)));
  }
  assertCanonicalChains(changeSet.operations, tree.caseSensitive);
  for (const operation of changeSet.operations) {
    applyOperation(tree, operation);
  }
  tree.assertInvariants();
  const after = new Map<string, string>();
  for (const node of tree.list()) {
    after.set(node.path, JSON.stringify(snapshotFingerprint(node)));
  }
  const changedPaths = assertDeclaredMutations(before, after, declaredPaths(changeSet.operations));
  const entries = tree.toCandidateEntries();
  const materializedTreeDigest = candidateTreeDigest(entries);
  const normalizedChangeSetDigest = computeNormalizedChangeSetDigest({
    baseSnapshotId: changeSet.baseSnapshotId,
    baseSnapshotRootDigest: changeSet.baseSnapshotRootDigest,
    operations: changeSet.operations,
  });
  return {
    changeSet,
    normalizedChangeSetDigest,
    materializedTreeDigest,
    changedPaths,
    entries,
  };
}
