import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  objectDigestFromBytes,
  sha256Utf8,
  taggedHash,
  type EvidenceId,
  type EvidenceNode,
  type GitHistoryManifest,
  type ObjectDigest,
  type SnapshotEntry,
  type SnapshotId,
  type SnapshotManifest,
} from "@pi-hec/contracts";
import { unicodeSimpleFoldTableDigest } from "@pi-hec/repository";
import {
  createEvidenceNode,
  defaultTrust,
  independenceGroupFor,
  makeProvenance,
  repositorySourceRef,
  type IdentifiedEvidenceNode,
} from "../src/graph.js";
import { normalizedTextDigest, type DedupeSubject } from "../src/dedupe.js";

export const PROJECT = "proj-evidence";
export const SNAPSHOT_ID = "snap_01234567-89ab-7cde-8f01-23456789abcd" as SnapshotId;
export const RUN_ID = "run_01900000-0000-7000-8000-000000000001";
export const TS = "2026-08-28T00:00:00.000Z";

export function digestOf(label: string): ObjectDigest {
  return sha256Utf8(label) as ObjectDigest;
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
    xattrsDigest: digestOf(id),
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
      const d = objectDigestFromBytes(bytes);
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
    volumeIdentity: "vol-evidence",
  };
  const payload = {
    repositoryId: "repo-evidence",
    workspaceId: "ws-evidence",
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
    repositoryId: "repo-evidence",
    workspaceId: "ws-evidence",
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
  const messageDigest = digestOf("evidence commit");
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
    repositoryId: "repo-evidence",
    refs: [{ name: "HEAD", targetObjectId: commitId }],
    commits: structuredClone(commits),
    shallowBoundaryObjectIds: [],
    replaceRefsIgnored: true,
  });
  return {
    schemaVersion: 1,
    repositoryId: "repo-evidence",
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

export function sampleNode(input: {
  identityKey: string;
  producer: string;
  blob: string;
  path?: string;
  kind?: EvidenceNode["kind"];
  historical?: boolean;
  authority?: number;
  independenceGroup?: string;
  label?: string;
  text?: string;
  byteStart?: number;
  byteEnd?: number;
}): IdentifiedEvidenceNode {
  const blobDigest = digestOf(input.blob);
  const text = input.text ?? input.blob;
  const pathName = input.path ?? `src/${input.identityKey}.ts`;
  const sourceKind = input.historical ? "git-history" : "repository";
  const path = input.historical ? `.git/commits/${input.identityKey}` : pathName;
  return createEvidenceNode({
    snapshotId: SNAPSHOT_ID,
    kind: input.kind ?? (input.historical ? "commit" : "code-region"),
    identityKey: input.identityKey,
    authorship: "DETERMINISTIC",
    label: input.label ?? input.identityKey,
    contentObjectDigest: blobDigest,
    status: "probable",
    trust: defaultTrust({
      independenceGroup:
        input.independenceGroup ?? independenceGroupFor(input.producer, blobDigest),
      authority: input.authority ?? 0.8,
    }),
    provenance: [
      makeProvenance({
        source: repositorySourceRef({
          snapshotId: SNAPSHOT_ID,
          artifactObjectDigest: blobDigest,
          path,
          quoteDigest: sha256Utf8(text),
          sourceKind,
          range:
            input.byteStart !== undefined && input.byteEnd !== undefined
              ? { kind: "bytes", byteStart: input.byteStart, byteEnd: input.byteEnd }
              : { kind: "whole" },
        }),
        extractorId: input.producer,
        extractorVersion: input.producer,
        observedAt: TS,
        contentDigest: sha256Utf8(text),
      }),
    ],
    estimatedTokens: Math.max(1, Math.ceil(text.length / 4)),
  });
}

export function sampleSubject(
  node: EvidenceNode,
  extras: Partial<DedupeSubject> & { producer: string; path: string },
): DedupeSubject {
  return {
    node,
    producer: extras.producer,
    blobDigest: extras.blobDigest ?? node.contentObjectDigest ?? "",
    scipSymbolId: extras.scipSymbolId ?? "",
    fqSignature: extras.fqSignature ?? "",
    astFingerprint: extras.astFingerprint ?? "",
    path: extras.path,
    byteStart: extras.byteStart ?? 0,
    byteEnd: extras.byteEnd ?? 10,
    generated: extras.generated ?? false,
    overloadKey: extras.overloadKey ?? "",
    normalizedTextDigest: extras.normalizedTextDigest ?? normalizedTextDigest(node.label),
  };
}

export function claimId(label: string): EvidenceId {
  return sampleNode({ identityKey: `claim:${label}`, producer: "claims", blob: label }).id;
}
