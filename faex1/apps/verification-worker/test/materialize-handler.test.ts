import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { sha256Hex } from "@pi-hec/contracts";
import { materializeCandidate } from "../src/index.js";

const SNAPSHOT_ID = "snap_01900000-0000-7000-8000-000000000001" as const;
const ROOT = sha256Hex("task-16-baseline-root");
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("materializeCandidate validates a ChangeSet and writes an ephemeral tree", async () => {
  const dest = await mkdtemp(path.join(tmpdir(), "pi-hec-worker-"));
  dirs.push(dest);
  const content = "from-worker\n";
  const result = await materializeCandidate({
    destRoot: dest,
    changeSet: {
      schemaVersion: 1,
      baseSnapshotId: SNAPSHOT_ID,
      baseSnapshotRootDigest: ROOT,
      operations: [
        {
          kind: "create_text",
          path: "src/out.txt",
          content,
          expectedAfterDigest: sha256Hex(Buffer.from(content, "utf8")),
          gitMode: "100644",
          expectedAbsent: true,
        },
      ],
    },
    baseline: {
      snapshotId: SNAPSHOT_ID,
      rootDigest: ROOT,
      filesystem: {
        platform: "windows",
        rootChildNameComparison: "case-insensitive",
        unicodeNormalization: "NFC",
      },
      entries: [{ entryType: "directory", path: "src" }],
    },
  });
  expect(result.changedPaths).toEqual(["src/out.txt"]);
  expect(await readFile(path.join(dest, "src", "out.txt"), "utf8")).toBe(content);
  expect(result.writtenPaths).toEqual(expect.arrayContaining(["src", "src/out.txt"]));
});
