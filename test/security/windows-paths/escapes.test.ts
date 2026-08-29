import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  taggedHash,
  type ObjectDigest,
  type SnapshotEntry,
  type SnapshotManifest,
} from "../../../packages/contracts/src/index.js";
import {
  MaterializeError,
  materializeSnapshot,
  unicodeSimpleFoldTableDigest,
} from "../../../packages/repository/src/index.js";

const PROJECT = "proj-sec";

function digest(text: string): ObjectDigest {
  return `sha256:${createHash("sha256").update(text).digest("hex")}` as ObjectDigest;
}

function meta(fileId: string) {
  return {
    kind: "windows" as const,
    fileId,
    securityDescriptorDigest: digest("sd"),
    alternateStreams: [],
  };
}

function manifest(entries: SnapshotEntry[]): SnapshotManifest {
  const filesystem = {
    platform: "windows" as const,
    rootChildNameComparison: "case-insensitive" as const,
    unicodeNormalization: "NFC" as const,
    unicodeSimpleFoldTableObjectDigest: unicodeSimpleFoldTableDigest(),
    pathGlobDialect: "pi-hec-pathglob/v1" as const,
    volumeIdentity: "vol-sec",
  };
  const rootDigest = taggedHash("snapshot-root", 1, {
    repositoryId: "repo-sec",
    workspaceId: "ws-sec",
    dirty: false,
    filesystem: {
      rootChildNameComparison: filesystem.rootChildNameComparison,
      unicodeNormalization: filesystem.unicodeNormalization,
      unicodeSimpleFoldTableObjectDigest: filesystem.unicodeSimpleFoldTableObjectDigest,
      pathGlobDialect: filesystem.pathGlobDialect,
      volumeIdentity: filesystem.volumeIdentity,
    },
    entries: JSON.parse(JSON.stringify(entries)),
    ignoredPathDigests: [],
    excludedPaths: [],
  });
  return {
    schemaVersion: 1,
    snapshotId: "snap_01234567-89ab-7cde-8f01-23456789abcd",
    repositoryId: "repo-sec",
    workspaceId: "ws-sec",
    dirty: false,
    filesystem,
    entries,
    ignoredPathDigests: [],
    excludedPaths: [],
    rootDigest,
    createdAt: "2026-08-28T00:00:00.000Z",
    runnerId: "runner-sec",
  };
}

const blobs = {
  putObject: async () => {
    throw new Error("putObject must not run in path-escape tests");
  },
  getObject: async () => {
    throw new Error("getObject must not run in path-escape tests");
  },
  objectPath: () => "",
};

test("junction-style relative escape symlink is rejected by materializer", async () => {
  await expect(
    materializeSnapshot({
      destRoot: "C:\\sandbox\\root",
      projectId: PROJECT,
      manifest: manifest([
        {
          path: "trap",
          platformMetadata: meta("j1"),
          entryType: "symlink",
          symlinkTarget: "..\\..\\Windows\\System32",
          gitMode: "120000",
        },
      ]),
      blobs,
    }),
  ).rejects.toMatchObject({ code: "SYMLINK_ESCAPE", name: "MaterializeError" });
});

test("UNC device and absolute targets cannot materialize", async () => {
  const cases = ["\\\\server\\share\\x", "C:\\\\Windows\\\\notepad.exe", "/etc/passwd"];
  for (const symlinkTarget of cases) {
    await expect(
      materializeSnapshot({
        destRoot: "C:\\sandbox\\root",
        projectId: PROJECT,
        manifest: manifest([
          {
            path: "escape",
            platformMetadata: meta("e1"),
            entryType: "symlink",
            symlinkTarget,
            gitMode: "120000",
          },
        ]),
        blobs,
      }),
    ).rejects.toBeInstanceOf(MaterializeError);
  }
});
