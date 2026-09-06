import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  objectDigestFromBytes,
  taggedHash,
  toJsonValue,
  type ObjectDigest,
  type SnapshotEntry,
  type SnapshotManifest,
} from "@pi-hec/contracts";
import {
  createFilesystemCas,
  MemoryStorageRecordSink,
  type FilesystemCas,
} from "@pi-hec/cas";
import {
  materializeSnapshot,
  MaterializeError,
  assertGitHistoryManifest,
  snapshotRootDigest,
  unicodeSimpleFoldTableDigest,
} from "../src/index.js";

const PROJECT = "proj-repo";
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function digest(bytes: Uint8Array): ObjectDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ObjectDigest;
}

function windowsMeta(fileId: string) {
  return {
    kind: "windows" as const,
    fileId,
    securityDescriptorDigest: digest(new Uint8Array([1, 2, 3])),
    alternateStreams: [] as {
      name: string;
      contentDigest: ReturnType<typeof digest>;
      byteSize: number;
    }[],
  };
}

async function openCas(): Promise<{ cas: FilesystemCas; rootDir: string }> {
  const rootDir = await tempDir("pi-hec-repo-cas-");
  const cas = createFilesystemCas({
    rootDir,
    sink: new MemoryStorageRecordSink(),
    kek: {
      unwrapProjectDek: () => ({
        keyId: "test-dek-1",
        dek: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      }),
    },
    occupancy: { isGcForbidden: () => false },
  });
  return { cas, rootDir };
}

function baseManifest(entries: SnapshotEntry[], extras: Partial<SnapshotManifest> = {}): SnapshotManifest {
  const payload = {
    repositoryId: "repo1",
    workspaceId: "ws1",
    dirty: true,
    filesystem: {
      platform: "windows" as const,
      rootChildNameComparison: "case-insensitive" as const,
      unicodeNormalization: "NFC" as const,
      unicodeSimpleFoldTableObjectDigest: unicodeSimpleFoldTableDigest(),
      pathGlobDialect: "pi-hec-pathglob/v1" as const,
      volumeIdentity: "vol-1",
    },
    entries,
    ignoredPathDigests: [] as ObjectDigest[],
    excludedPaths: [] as SnapshotManifest["excludedPaths"],
  };
  const rootDigest = taggedHash("snapshot-root", 1, {
    repositoryId: payload.repositoryId,
    workspaceId: payload.workspaceId,
    dirty: payload.dirty,
    filesystem: {
      rootChildNameComparison: payload.filesystem.rootChildNameComparison,
      unicodeNormalization: payload.filesystem.unicodeNormalization,
      unicodeSimpleFoldTableObjectDigest: payload.filesystem.unicodeSimpleFoldTableObjectDigest,
      pathGlobDialect: payload.filesystem.pathGlobDialect,
      volumeIdentity: payload.filesystem.volumeIdentity,
    },
    entries: toJsonValue(entries),
    ignoredPathDigests: [],
    excludedPaths: [],
  });
  return {
    schemaVersion: 1,
    snapshotId: "snap_01234567-89ab-7cde-8f01-23456789abcd",
    createdAt: "2026-08-28T00:00:00.000Z",
    runnerId: "runner-1",
    rootDigest,
    ...payload,
    ...extras,
  };
}

test("materialize writes blobs and re-hash equals rootDigest", async () => {
  const { cas } = await openCas();
  const bytes = new TextEncoder().encode("hello-snapshot");
  const stored = await cas.putObject({
    projectId: PROJECT,
    bytes,
    mediaType: "application/octet-stream",
    classification: "internal",
  });
  expect(stored.objectDigest).toBe(objectDigestFromBytes(bytes));
  const file: SnapshotEntry = {
    path: "src/hello.txt",
    platformMetadata: windowsMeta("file-1"),
    entryType: "file",
    contentDigest: stored.objectDigest,
    size: bytes.byteLength,
    gitMode: "100644",
    storage: { kind: "blob", objectDigest: stored.objectDigest },
  };
  const dir: SnapshotEntry = {
    path: "src",
    platformMetadata: windowsMeta("dir-1"),
    entryType: "directory",
    childNameComparison: "case-insensitive",
  };
  const manifest = baseManifest([dir, file]);
  const dest = await tempDir("pi-hec-mat-");
  const result = await materializeSnapshot({
    destRoot: dest,
    projectId: PROJECT,
    manifest,
    blobs: cas,
  });
  expect(result.rootDigest).toBe(manifest.rootDigest);
  expect(result.rootDigest).toBe(snapshotRootDigest(manifest));
  expect(await readFile(path.join(dest, "src", "hello.txt"), "utf8")).toBe("hello-snapshot");
});

test("chunked file reconstructs and hashes to contentDigest", async () => {
  const { cas } = await openCas();
  const bytes = randomBytes(8);
  const left = bytes.subarray(0, 4);
  const right = bytes.subarray(4);
  const leftPut = await cas.putObject({
    projectId: PROJECT,
    bytes: left,
    mediaType: "application/octet-stream",
    classification: "internal",
  });
  const rightPut = await cas.putObject({
    projectId: PROJECT,
    bytes: right,
    mediaType: "application/octet-stream",
    classification: "internal",
  });
  const file: SnapshotEntry = {
    path: "assets/big.bin",
    platformMetadata: windowsMeta("file-2"),
    entryType: "file",
    contentDigest: digest(bytes),
    size: bytes.byteLength,
    gitMode: "100644",
    storage: {
      kind: "chunks",
      chunks: [
        { digest: leftPut.objectDigest, offset: 0, length: 4 },
        { digest: rightPut.objectDigest, offset: 4, length: 4 },
      ],
    },
  };
  const manifest = baseManifest([file]);
  const dest = await tempDir("pi-hec-chunks-");
  await materializeSnapshot({ destRoot: dest, projectId: PROJECT, manifest, blobs: cas });
  expect(Buffer.from(await readFile(path.join(dest, "assets", "big.bin")))).toEqual(bytes);
});

test("escaping symlink target is rejected", async () => {
  const { cas } = await openCas();
  const link: SnapshotEntry = {
    path: "out/link",
    platformMetadata: windowsMeta("link-1"),
    entryType: "symlink",
    symlinkTarget: "../../outside",
    gitMode: "120000",
  };
  const dir: SnapshotEntry = {
    path: "out",
    platformMetadata: windowsMeta("dir-2"),
    entryType: "directory",
    childNameComparison: "case-insensitive",
  };
  const manifest = baseManifest([dir, link]);
  const dest = await tempDir("pi-hec-link-");
  await expect(
    materializeSnapshot({ destRoot: dest, projectId: PROJECT, manifest, blobs: cas }),
  ).rejects.toMatchObject({ code: "SYMLINK_ESCAPE" });
});

test("contained symlink is created", async () => {
  const { cas } = await openCas();
  const bytes = new TextEncoder().encode("target-bytes");
  const stored = await cas.putObject({
    projectId: PROJECT,
    bytes,
    mediaType: "application/octet-stream",
    classification: "internal",
  });
  const file: SnapshotEntry = {
    path: "src/app.ts",
    platformMetadata: windowsMeta("file-3"),
    entryType: "file",
    contentDigest: stored.objectDigest,
    size: bytes.byteLength,
    gitMode: "100644",
    storage: { kind: "blob", objectDigest: stored.objectDigest },
  };
  const dir: SnapshotEntry = {
    path: "src",
    platformMetadata: windowsMeta("dir-3"),
    entryType: "directory",
    childNameComparison: "case-insensitive",
  };
  const link: SnapshotEntry = {
    path: "alias",
    platformMetadata: windowsMeta("link-2"),
    entryType: "symlink",
    symlinkTarget: "src/app.ts",
    gitMode: "120000",
  };
  const manifest = baseManifest([dir, file, link]);
  const dest = await tempDir("pi-hec-oklink-");
  await materializeSnapshot({ destRoot: dest, projectId: PROJECT, manifest, blobs: cas });
  const info = await stat(path.join(dest, "alias"));
  expect(info.isSymbolicLink() || info.isFile()).toBe(true);
});

test("UNC and absolute symlink targets are rejected", async () => {
  const { cas } = await openCas();
  const link: SnapshotEntry = {
    path: "evil",
    platformMetadata: windowsMeta("link-3"),
    entryType: "symlink",
    symlinkTarget: "\\\\server\\share\\secret",
    gitMode: "120000",
  };
  const manifest = baseManifest([link]);
  const dest = await tempDir("pi-hec-unc-");
  await expect(
    materializeSnapshot({ destRoot: dest, projectId: PROJECT, manifest, blobs: cas }),
  ).rejects.toBeInstanceOf(MaterializeError);
});

test("GitHistoryManifestSchema accepts recursive changedPaths and RFC3339 timestamps", () => {
  const history = {
    schemaVersion: 1 as const,
    repositoryId: "repo1",
    snapshotId: "snap_01234567-89ab-7cde-8f01-23456789abcd",
    historyRootDigest: digest(new Uint8Array([4, 5, 6])),
    refs: [{ name: "refs/heads/main", targetObjectId: "a".repeat(40) }],
    commits: [
      {
        objectId: "b".repeat(40),
        parentObjectIds: ["c".repeat(40)],
        authorTimestamp: "2026-08-28T00:00:00.000Z",
        committerTimestamp: "2026-08-28T00:00:01.000Z",
        messageDigest: digest(new Uint8Array([7])),
        changedPaths: ["readme.md", "src/app.ts", "packages/foo/lib.rs"],
      },
    ],
    shallowBoundaryObjectIds: ["d".repeat(40)],
    replaceRefsIgnored: true as const,
  };
  expect(() => { assertGitHistoryManifest(history); }).not.toThrow();
  expect(() => { assertGitHistoryManifest({
      ...history,
      replaceRefsIgnored: false,
    }); },
  ).toThrow();
});
