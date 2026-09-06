import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { incrementallyUpdateIndex, openIndexDatabase, rebuildSnapshotIndex } from "../src/index.js";
import {
  PROJECT,
  cleanupTempDirs,
  fileEntry,
  gitHistory,
  memoryBlobs,
  snapshotOf,
  tempDir,
  utf8,
} from "./helpers.js";

afterEach(async () => {
  await cleanupTempDirs();
});

test("incremental update keeps unchanged evidence ids and changes the revision", async () => {
  const blobs = memoryBlobs();
  const stable = fileEntry("stable.ts", utf8("export function stable() { return 1; }\n"), blobs);
  const changing = fileEntry(
    "changing.ts",
    utf8("export function changing() { return 1; }\n"),
    blobs,
  );
  const firstManifest = snapshotOf([stable, changing]);
  const dir = await tempDir("pi-hec-inc-");
  const dbPath = path.join(dir, "index.db");
  const first = await rebuildSnapshotIndex({
    dbPath,
    projectId: PROJECT,
    manifest: firstManifest,
    getBlob: blobs.getBlob,
  });
  const changed = fileEntry(
    "changing.ts",
    utf8("export function changing() { return 2; }\n"),
    blobs,
  );
  const secondManifest = snapshotOf([stable, changed]);
  const second = await incrementallyUpdateIndex({
    dbPath,
    projectId: PROJECT,
    manifest: secondManifest,
    previousManifest: firstManifest,
    getBlob: blobs.getBlob,
  });
  expect(second.indexRevision).not.toBe(first.indexRevision);
  const kept = first.evidenceIds.filter((id) => second.evidenceIds.includes(id));
  expect(kept.length).toBeGreaterThan(0);
  expect(second.evidenceIds.some((id) => !first.evidenceIds.includes(id))).toBe(true);
});

test("toolchain mismatch forces a full rebuild", async () => {
  const blobs = memoryBlobs();
  const entries = [fileEntry("a.ts", utf8("export const a = 1;\n"), blobs)];
  const manifest = snapshotOf(entries);
  const dir = await tempDir("pi-hec-full-");
  const dbPath = path.join(dir, "index.db");
  const first = await rebuildSnapshotIndex({
    dbPath,
    projectId: PROJECT,
    manifest,
    getBlob: blobs.getBlob,
  });
  const poison = openIndexDatabase(dbPath);
  poison
    .prepare(
      `INSERT INTO files(path, entry_type, content_digest, size, language, is_binary, is_generated, category, interface_fingerprint)
       VALUES ('poison', 'file', null, 0, 'x', 0, 0, 'other', '')`,
    )
    .run();
  poison
    .prepare("INSERT OR REPLACE INTO index_meta(key, value) VALUES ('toolchainDigest', ?)")
    .run(`sha256:${"00".repeat(32)}`);
  poison.close();
  const again = await incrementallyUpdateIndex({
    dbPath,
    projectId: PROJECT,
    manifest,
    previousManifest: manifest,
    getBlob: blobs.getBlob,
  });
  expect(again.indexRevision).toBe(first.indexRevision);
  expect(again.evidenceIds).toEqual(first.evidenceIds);
  const db = openIndexDatabase(dbPath);
  try {
    const poisonRow = db.prepare("SELECT path FROM files WHERE path = 'poison'").get();
    expect(poisonRow).toBeUndefined();
  } finally {
    db.close();
  }
});

test("deleting a path keeps IMPORTS between remaining files", async () => {
  const blobs = memoryBlobs();
  const a = fileEntry("a.ts", utf8("export function alpha() { return 1; }\n"), blobs);
  const b = fileEntry(
    "b.ts",
    utf8("import { alpha } from './a.ts';\nexport function beta() { return alpha(); }\n"),
    blobs,
  );
  const c = fileEntry(
    "c.ts",
    utf8("import { alpha } from './a.ts';\nexport function gamma() { return alpha(); }\n"),
    blobs,
  );
  const extra = fileEntry("d.ts", utf8("export const d = 1;\n"), blobs);
  const firstManifest = snapshotOf([a, b, c, extra]);
  const dir = await tempDir("pi-hec-imp-");
  const dbPath = path.join(dir, "index.db");
  await rebuildSnapshotIndex({
    dbPath,
    projectId: PROJECT,
    manifest: firstManifest,
    getBlob: blobs.getBlob,
  });
  const secondManifest = snapshotOf([a, b, extra]);
  await incrementallyUpdateIndex({
    dbPath,
    projectId: PROJECT,
    manifest: secondManifest,
    previousManifest: firstManifest,
    getBlob: blobs.getBlob,
  });
  const db = openIndexDatabase(dbPath);
  try {
    const imports = db
      .prepare(
        `SELECT f.path AS fromPath, t.path AS toPath
         FROM graph_edges e
         JOIN units f ON f.evidence_id = e.from_id
         JOIN units t ON t.evidence_id = e.to_id
         WHERE e.relation = 'IMPORTS' AND f.kind = 'file' AND t.kind = 'file'`,
      )
      .all() as { fromPath: string; toPath: string }[];
    expect(imports.some((edge) => edge.fromPath === "b.ts" && edge.toPath === "a.ts")).toBe(true);
    expect(imports.some((edge) => edge.fromPath === "c.ts")).toBe(false);
    const unitCount = (db.prepare("SELECT COUNT(*) AS n FROM units").get() as { n: number }).n;
    const vecCount = (db.prepare("SELECT COUNT(*) AS n FROM units_vec").get() as { n: number }).n;
    expect(vecCount).toBe(unitCount);
  } finally {
    db.close();
  }
});

test("git tables update when history digest changes during incremental file updates", async () => {
  const blobs = memoryBlobs();
  const a = fileEntry("a.ts", utf8("export const a = 1;\n"), blobs);
  const b = fileEntry("b.ts", utf8("export const b = 1;\n"), blobs);
  const extra = fileEntry("c.ts", utf8("export const c = 1;\n"), blobs);
  const firstManifest = snapshotOf([a, b, extra]);
  const firstGit = gitHistory(["a.ts"], { objectId: "commit111aaaaa" });
  const dir = await tempDir("pi-hec-gitinc-");
  const dbPath = path.join(dir, "index.db");
  await rebuildSnapshotIndex({
    dbPath,
    projectId: PROJECT,
    manifest: firstManifest,
    getBlob: blobs.getBlob,
    gitHistory: firstGit,
  });
  const b2 = fileEntry("b.ts", utf8("export const b = 2;\n"), blobs);
  const secondManifest = snapshotOf([a, b2, extra]);
  const secondGit = gitHistory(["a.ts", "b.ts"], { objectId: "commit222bbbbb" });
  await incrementallyUpdateIndex({
    dbPath,
    projectId: PROJECT,
    manifest: secondManifest,
    previousManifest: firstManifest,
    getBlob: blobs.getBlob,
    gitHistory: secondGit,
  });
  const db = openIndexDatabase(dbPath);
  try {
    const commits = db
      .prepare("SELECT object_id AS objectId, changed_paths_json AS changed FROM git_commits")
      .all() as { objectId: string; changed: string }[];
    expect(commits).toHaveLength(1);
    expect(commits[0]?.objectId).toBe("commit222bbbbb");
    expect(JSON.parse(commits[0]?.changed ?? "[]")).toEqual(["a.ts", "b.ts"]);
  } finally {
    db.close();
  }
});
