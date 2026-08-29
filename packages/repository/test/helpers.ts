import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  objectDigestFromBytes,
  taggedHash,
  type GitHistoryManifest,
  type ObjectDigest,
  type SnapshotEntry,
  type SnapshotId,
  type SnapshotManifest,
} from "@pi-hec/contracts";
import { unicodeSimpleFoldTableDigest } from "../src/materialize-snapshot.js";

export const PROJECT = "proj-index";
export const SNAPSHOT_ID = "snap_01234567-89ab-7cde-8f01-23456789abcd" as SnapshotId;
export const TS = "2026-08-28T00:00:00.000Z";

export function digest(bytes: Uint8Array): ObjectDigest {
  return objectDigestFromBytes(bytes);
}

export function utf8(text: string): Uint8Array {
  return Buffer.from(text, "utf8");
}

export function posixMeta(id: string) {
  return {
    kind: "posix" as const,
    device: "dev1",
    inode: id,
    mode: 33188,
    ownerId: 0,
    groupId: 0,
    xattrsDigest: digest(utf8(id)),
  };
}

export type MemoryBlobs = {
  getBlob: (objectDigest: ObjectDigest) => Promise<Uint8Array>;
  put: (bytes: Uint8Array) => ObjectDigest;
};

export function memoryBlobs(): MemoryBlobs {
  const map = new Map<string, Uint8Array>();
  return {
    put(bytes) {
      const d = digest(bytes);
      map.set(d, bytes);
      return d;
    },
    getBlob(objectDigest) {
      const found = map.get(objectDigest);
      if (found === undefined) {
        return Promise.reject(new Error(`missing blob ${objectDigest}`));
      }
      return Promise.resolve(found);
    },
  };
}

export function fileEntry(pathName: string, bytes: Uint8Array, blobs: MemoryBlobs): SnapshotEntry {
  const stored = blobs.put(bytes);
  return {
    path: pathName,
    platformMetadata: posixMeta(pathName),
    entryType: "file",
    contentDigest: stored,
    size: bytes.byteLength,
    gitMode: "100644",
    storage: { kind: "blob", objectDigest: stored },
  };
}

export function dirEntry(pathName: string): SnapshotEntry {
  return {
    path: pathName,
    platformMetadata: posixMeta(pathName),
    entryType: "directory",
    childNameComparison: "case-sensitive",
  };
}

export function symlinkEntry(pathName: string, target: string): SnapshotEntry {
  return {
    path: pathName,
    platformMetadata: posixMeta(pathName),
    entryType: "symlink",
    symlinkTarget: target,
    gitMode: "120000",
  };
}

export function snapshotOf(
  entries: SnapshotEntry[],
  extras: Partial<SnapshotManifest> = {},
): SnapshotManifest {
  const filesystem = {
    platform: "linux" as const,
    rootChildNameComparison: "case-sensitive" as const,
    unicodeNormalization: "NFC" as const,
    unicodeSimpleFoldTableObjectDigest: unicodeSimpleFoldTableDigest(),
    pathGlobDialect: "pi-hec-pathglob/v1" as const,
    volumeIdentity: "vol-index",
  };
  const payload = {
    repositoryId: "repo-index",
    workspaceId: "ws-index",
    dirty: false,
    filesystem: {
      rootChildNameComparison: filesystem.rootChildNameComparison,
      unicodeNormalization: filesystem.unicodeNormalization,
      unicodeSimpleFoldTableObjectDigest: filesystem.unicodeSimpleFoldTableObjectDigest,
      pathGlobDialect: filesystem.pathGlobDialect,
      volumeIdentity: filesystem.volumeIdentity,
    },
    entries: structuredClone(entries),
    ignoredPathDigests: [],
    excludedPaths: [],
  };
  const rootDigest = taggedHash("snapshot-root", 1, payload);
  return {
    schemaVersion: 1,
    snapshotId: SNAPSHOT_ID,
    createdAt: TS,
    runnerId: "runner-1",
    rootDigest,
    repositoryId: "repo-index",
    workspaceId: "ws-index",
    dirty: false,
    filesystem,
    entries,
    ignoredPathDigests: [],
    excludedPaths: [],
    ...extras,
  };
}

export function gitHistory(
  changed: readonly string[],
  extras: { patchDigest?: ObjectDigest; objectId?: string } = {},
): GitHistoryManifest {
  const commitId = extras.objectId ?? "abc123def456";
  const messageDigest = digest(utf8("index commit"));
  const commits = [
    {
      objectId: commitId,
      parentObjectIds: [] as string[],
      authorTimestamp: TS,
      committerTimestamp: TS,
      messageDigest,
      changedPaths: [...changed],
      ...(extras.patchDigest !== undefined ? { patchArtifactObjectDigest: extras.patchDigest } : {}),
    },
  ];
  const historyRootDigest = taggedHash("git-history-root", 1, {
    repositoryId: "repo-index",
    refs: [{ name: "HEAD", targetObjectId: commitId }],
    commits: structuredClone(commits),
    shallowBoundaryObjectIds: [],
    replaceRefsIgnored: true,
  });
  return {
    schemaVersion: 1,
    repositoryId: "repo-index",
    snapshotId: SNAPSHOT_ID,
    historyRootDigest,
    refs: [{ name: "HEAD", targetObjectId: commitId }],
    commits,
    shallowBoundaryObjectIds: [],
    replaceRefsIgnored: true,
  };
}

const dirs: string[] = [];

export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
