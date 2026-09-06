import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { openIndexDatabase, rebuildSnapshotIndex, searchBm25, searchVector } from "../src/index.js";
import {
  PROJECT,
  cleanupTempDirs,
  dirEntry,
  fileEntry,
  memoryBlobs,
  snapshotOf,
  tempDir,
  utf8,
} from "./helpers.js";

afterEach(async () => {
  await cleanupTempDirs();
});

test("BM25 retrieves the unique lexical token", async () => {
  const blobs = memoryBlobs();
  const entries = [
    dirEntry("src"),
    fileEntry(
      "src/math.ts",
      utf8("export function add(a: number, b: number) { return a + b; }\n"),
      blobs,
    ),
    fileEntry("README.md", utf8("# Docs\n\nThe fnordwidget API is documented here.\n"), blobs),
  ];
  const manifest = snapshotOf(entries);
  const dir = await tempDir("pi-hec-bm25-");
  const dbPath = path.join(dir, "index.db");
  await rebuildSnapshotIndex({ dbPath, projectId: PROJECT, manifest, getBlob: blobs.getBlob });
  const db = openIndexDatabase(dbPath);
  try {
    const hits = searchBm25(db, "fnordwidget");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((hit) => hit.path === "README.md")).toBe(true);
  } finally {
    db.close();
  }
});

test("vector search with language filter returns only matching language", async () => {
  const blobs = memoryBlobs();
  const entries = [
    fileEntry("src.ts", utf8("export function uniqueVectorPhraseAlpha() { return 1; }\n"), blobs),
    fileEntry("README.md", utf8("# uniqueVectorPhraseAlpha in markdown\n"), blobs),
  ];
  const manifest = snapshotOf(entries);
  const dir = await tempDir("pi-hec-vec-");
  const dbPath = path.join(dir, "index.db");
  await rebuildSnapshotIndex({ dbPath, projectId: PROJECT, manifest, getBlob: blobs.getBlob });
  const db = openIndexDatabase(dbPath);
  try {
    const hits = searchVector(db, "uniqueVectorPhraseAlpha", { k: 8, language: "typescript" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.language === "typescript")).toBe(true);
  } finally {
    db.close();
  }
});
