import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { openIndexDatabase, rebuildSnapshotIndex, searchBm25 } from "../src/index.js";
import {
  PROJECT,
  cleanupTempDirs,
  dirEntry,
  fileEntry,
  gitHistory,
  memoryBlobs,
  snapshotOf,
  symlinkEntry,
  tempDir,
  utf8,
} from "./helpers.js";

afterEach(async () => {
  await cleanupTempDirs();
});

test("two rebuilds of the same snapshot and toolchain reproduce revision and evidence ids", async () => {
  const blobs = memoryBlobs();
  const entries = [
    dirEntry("src"),
    fileEntry(
      "src/math.ts",
      utf8("export function add(a: number, b: number) { return a + b; }\n"),
      blobs,
    ),
    fileEntry(
      "src/math.test.ts",
      utf8("test('adds fnordwidget', () => { expect(add(1,2)).toBe(3); });\n"),
      blobs,
    ),
    fileEntry("README.md", utf8("# Known\n\nfnordwidget docs\n"), blobs),
    fileEntry("package.json", utf8('{"name":"known","version":"1.0.0"}\n'), blobs),
  ];
  const manifest = snapshotOf(entries);
  const history = gitHistory(["src/math.ts", "README.md"]);
  const firstDir = await tempDir("pi-hec-idx-a-");
  const secondDir = await tempDir("pi-hec-idx-b-");
  const first = await rebuildSnapshotIndex({
    dbPath: path.join(firstDir, "index.db"),
    projectId: PROJECT,
    manifest,
    getBlob: blobs.getBlob,
    gitHistory: history,
  });
  const second = await rebuildSnapshotIndex({
    dbPath: path.join(secondDir, "index.db"),
    projectId: PROJECT,
    manifest,
    getBlob: blobs.getBlob,
    gitHistory: history,
  });
  expect(first.indexRevision).toBe(second.indexRevision);
  expect(first.evidenceIds).toEqual(second.evidenceIds);
  expect(first.unitCount).toBeGreaterThan(0);
});

test("unknown language remains searchable via fallback windows", async () => {
  const blobs = memoryBlobs();
  const entries = [
    dirEntry("src"),
    fileEntry(
      "src/app.xyz",
      utf8("fnordwidget from an unknown language still searchable via lexical fallback.\n"),
      blobs,
    ),
  ];
  const manifest = snapshotOf(entries);
  const dir = await tempDir("pi-hec-idx-unk-");
  const dbPath = path.join(dir, "index.db");
  const result = await rebuildSnapshotIndex({
    dbPath,
    projectId: PROJECT,
    manifest,
    getBlob: blobs.getBlob,
  });
  expect(result.evidenceIds.length).toBeGreaterThan(0);
  const db = openIndexDatabase(dbPath);
  try {
    const hits = searchBm25(db, "fnordwidget");
    expect(hits.some((hit) => hit.path === "src/app.xyz")).toBe(true);
  } finally {
    db.close();
  }
});

test("symlink entries are recorded and target bytes are not in FTS", async () => {
  const blobs = memoryBlobs();
  const realToken = "zxqvRealFileToken99";
  const followBlobToken = "zxqvFollowedSymlinkBlob99";
  blobs.put(utf8(`export const leaked = "${followBlobToken}";\n`));
  const entries = [
    dirEntry("src"),
    fileEntry("src/real.ts", utf8(`export const real = "${realToken}";\n`), blobs),
    symlinkEntry("src/link.ts", "real.ts"),
  ];
  const manifest = snapshotOf(entries);
  const dir = await tempDir("pi-hec-idx-link-");
  const dbPath = path.join(dir, "index.db");
  const result = await rebuildSnapshotIndex({
    dbPath,
    projectId: PROJECT,
    manifest,
    getBlob: blobs.getBlob,
  });
  expect(result.fileCount).toBe(3);
  const db = openIndexDatabase(dbPath);
  try {
    const realHits = searchBm25(db, realToken);
    expect(realHits.some((hit) => hit.path === "src/real.ts")).toBe(true);
    expect(realHits.some((hit) => hit.path === "src/link.ts")).toBe(false);
    expect(searchBm25(db, followBlobToken)).toEqual([]);
    const linkUnits = db
      .prepare("SELECT path AS path FROM units WHERE path = ?")
      .all("src/link.ts") as {
      path: string;
    }[];
    expect(linkUnits).toEqual([]);
  } finally {
    db.close();
  }
});

test("binary and generated files are ingested without blocking unknown or generated paths", async () => {
  const blobs = memoryBlobs();
  const binary = new Uint8Array([0, 1, 2, 3, 255, 0]);
  const entries = [
    dirEntry("dist"),
    dirEntry("src"),
    fileEntry("dist/out.js", utf8("// @generated\nexport const g = 1;\n"), blobs),
    fileEntry("src/gen.ts", utf8("export const src = 1;\n"), blobs),
    fileEntry("icon.bin", binary, blobs),
  ];
  const manifest = snapshotOf(entries);
  const dir = await tempDir("pi-hec-idx-bin-");
  const result = await rebuildSnapshotIndex({
    dbPath: path.join(dir, "index.db"),
    projectId: PROJECT,
    manifest,
    getBlob: blobs.getBlob,
  });
  expect(result.fileCount).toBe(5);
});

test("no-git snapshot still produces an index revision", async () => {
  const blobs = memoryBlobs();
  const entries = [fileEntry("README.md", utf8("# no git\n"), blobs)];
  const manifest = snapshotOf(entries);
  const dir = await tempDir("pi-hec-idx-nogit-");
  const result = await rebuildSnapshotIndex({
    dbPath: path.join(dir, "index.db"),
    projectId: PROJECT,
    manifest,
    getBlob: blobs.getBlob,
  });
  expect(result.indexRevision.startsWith("sha256:")).toBe(true);
  expect(result.evidenceIds.length).toBeGreaterThan(0);
});

test("monorepo packages are both indexed", async () => {
  const blobs = memoryBlobs();
  const entries = [
    dirEntry("packages"),
    dirEntry("packages/a"),
    dirEntry("packages/a/src"),
    dirEntry("packages/b"),
    dirEntry("packages/b/src"),
    fileEntry(
      "packages/a/src/index.ts",
      utf8("export function alpha() { return 'monorepo-a'; }\n"),
      blobs,
    ),
    fileEntry(
      "packages/b/src/index.ts",
      utf8(
        "import { alpha } from '../../a/src/index.ts';\nexport function beta() { return alpha(); }\n",
      ),
      blobs,
    ),
  ];
  const manifest = snapshotOf(entries);
  const dir = await tempDir("pi-hec-idx-mono-");
  const result = await rebuildSnapshotIndex({
    dbPath: path.join(dir, "index.db"),
    projectId: PROJECT,
    manifest,
    getBlob: blobs.getBlob,
  });
  expect(result.unitCount).toBeGreaterThan(2);
});

test("SCIP REFERENCES edges use validated symbol.path units not self-loops", async () => {
  const blobs = memoryBlobs();
  const scip = {
    metadata: { toolInfo: { name: "scip-typescript" } },
    documents: [{ relative_path: "src/math.ts", symbols: [{ symbol: "add" }] }],
  };
  const entries = [
    dirEntry("src"),
    fileEntry(
      "src/math.ts",
      utf8("export function add(a: number, b: number) { return a + b; }\n"),
      blobs,
    ),
    fileEntry("index.scip.json", utf8(JSON.stringify(scip)), blobs),
  ];
  const manifest = snapshotOf(entries);
  const dir = await tempDir("pi-hec-idx-scip-");
  const dbPath = path.join(dir, "index.db");
  await rebuildSnapshotIndex({ dbPath, projectId: PROJECT, manifest, getBlob: blobs.getBlob });
  const db = openIndexDatabase(dbPath);
  try {
    const edges = db
      .prepare(
        "SELECT from_id AS fromId, to_id AS toId, relation AS relation FROM graph_edges WHERE relation = 'REFERENCES'",
      )
      .all() as { fromId: string; toId: string; relation: string }[];
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((edge) => edge.fromId !== edge.toId)).toBe(true);
  } finally {
    db.close();
  }
});

test("git history with patchArtifactObjectDigest creates a diff unit from those bytes", async () => {
  const blobs = memoryBlobs();
  const patch = utf8(
    "diff --git a/src/math.ts b/src/math.ts\n+export function add() { return 1; }\n",
  );
  const patchDigest = blobs.put(patch);
  const entries = [fileEntry("src/math.ts", utf8("export function add() { return 1; }\n"), blobs)];
  const manifest = snapshotOf(entries);
  const history = gitHistory(["src/math.ts"], { patchDigest });
  const dir = await tempDir("pi-hec-idx-diff-");
  const dbPath = path.join(dir, "index.db");
  await rebuildSnapshotIndex({
    dbPath,
    projectId: PROJECT,
    manifest,
    getBlob: blobs.getBlob,
    gitHistory: history,
  });
  const db = openIndexDatabase(dbPath);
  try {
    const diff = db
      .prepare("SELECT kind AS kind, text AS text FROM units WHERE kind = 'diff'")
      .get() as { kind: string; text: string } | undefined;
    expect(diff?.kind).toBe("diff");
    expect(diff?.text).toContain("diff --git");
  } finally {
    db.close();
  }
});
