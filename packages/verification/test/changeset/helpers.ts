import { expect } from "vitest";
import { sha256Hex, sha256Utf8, type Digest, type SnapshotId } from "@pi-hec/contracts";
import {
  ChangeSetError,
  validateAndApplyChangeSet,
  type BaselineEntry,
  type ChangeSetBaseline,
} from "../../src/index.js";

export const SNAPSHOT_ID = "snap_01900000-0000-7000-8000-000000000001" as SnapshotId;
export const ROOT = sha256Utf8("task-16-baseline-root");

export function parentPath(path: string): string | undefined {
  const index = path.lastIndexOf("/");
  return index === -1 ? undefined : path.slice(0, index);
}

export function fileEntry(
  path: string,
  content: string | Uint8Array,
  gitMode: "100644" | "100755" = "100644",
): BaselineEntry {
  const bytes =
    typeof content === "string" ? new Uint8Array(Buffer.from(content, "utf8")) : content;
  return {
    entryType: "file",
    path,
    gitMode,
    bytes,
    contentDigest: sha256Hex(bytes),
  };
}

export function dirEntry(path: string): BaselineEntry {
  return { entryType: "directory", path };
}

export function symlinkEntry(path: string, target: string): BaselineEntry {
  return {
    entryType: "symlink",
    path,
    symlinkTarget: target,
    contentDigest: sha256Utf8(target),
  };
}

export function withParents(entries: readonly BaselineEntry[]): BaselineEntry[] {
  const byPath = new Map<string, BaselineEntry>();
  for (const entry of entries) {
    byPath.set(entry.path, entry);
    let parent = parentPath(entry.path);
    while (parent !== undefined) {
      if (!byPath.has(parent)) {
        byPath.set(parent, dirEntry(parent));
      }
      parent = parentPath(parent);
    }
  }
  return [...byPath.values()];
}

export function baseline(
  entries: readonly BaselineEntry[],
  extras: Partial<ChangeSetBaseline["filesystem"]> = {},
): ChangeSetBaseline {
  return {
    snapshotId: SNAPSHOT_ID,
    rootDigest: ROOT,
    filesystem: {
      platform: "windows",
      rootChildNameComparison: "case-insensitive",
      unicodeNormalization: "NFC",
      ...extras,
    },
    entries: withParents(entries),
  };
}

export function changeSet(operations: unknown[]) {
  return {
    schemaVersion: 1 as const,
    baseSnapshotId: SNAPSHOT_ID,
    baseSnapshotRootDigest: ROOT,
    operations,
  };
}

export function apply(operations: unknown[], entries: readonly BaselineEntry[] = []) {
  return validateAndApplyChangeSet({
    changeSet: changeSet(operations),
    baseline: baseline(entries),
  });
}

export function expectCode(run: () => void, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ChangeSetError);
    expect((error as ChangeSetError).code).toBe(code);
    return;
  }
  throw new Error(`expected ChangeSetError ${code}`);
}

export function digestText(content: string): Digest {
  return sha256Hex(Buffer.from(content, "utf8"));
}

export { sha256Hex, sha256Utf8 };
