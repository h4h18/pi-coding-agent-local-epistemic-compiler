import { graphFromUnits, type GraphUnit } from "../graph/edges.js";
import { gitUnitsAndEdges } from "../git/history.js";
import { metaGet, metaSet, openIndexDatabase, type SqliteDatabase } from "../index-db.js";
import { reembedAllVectors } from "../vector/store.js";
import { ingestSnapshotFiles, persistGitTables, persistIndex, rebuildSnapshotIndex } from "./rebuild.js";
import { indexRevisionDigest, toolchainDigest } from "./revision.js";
import type { IncrementalUpdateInput, RebuildIndexResult } from "./types.js";
import type { SnapshotId } from "@pi-hec/contracts";

function fileDigestMap(entries: IncrementalUpdateInput["manifest"]["entries"]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (entry.entryType === "file") {
      map.set(entry.path, entry.contentDigest);
    }
  }
  return map;
}

function changedPaths(previous: Map<string, string>, next: Map<string, string>): Set<string> {
  const changed = new Set<string>();
  for (const path of previous.keys()) {
    if (!next.has(path)) {
      changed.add(path);
    }
  }
  for (const [path, digest] of next) {
    if (previous.get(path) !== digest) {
      changed.add(path);
    }
  }
  return changed;
}

function deleteUnitRow(db: SqliteDatabase, evidenceId: string): void {
  db.prepare("DELETE FROM units_fts WHERE evidence_id = ?").run(evidenceId);
  db.prepare("DELETE FROM lexical_tokens WHERE evidence_id = ?").run(evidenceId);
  db.prepare("DELETE FROM graph_edges WHERE from_id = ? OR to_id = ?").run(evidenceId, evidenceId);
}

function deletePath(db: SqliteDatabase, path: string): void {
  const rows = db.prepare("SELECT evidence_id AS evidenceId FROM units WHERE path = ?").all(path) as {
    evidenceId: string;
  }[];
  for (const row of rows) {
    deleteUnitRow(db, row.evidenceId);
  }
  db.prepare("DELETE FROM units WHERE path = ?").run(path);
  db.prepare("DELETE FROM files WHERE path = ?").run(path);
}

function deleteUnitsByKinds(db: SqliteDatabase, kinds: readonly string[]): void {
  const placeholders = kinds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT evidence_id AS evidenceId FROM units WHERE kind IN (${placeholders})`)
    .all(...kinds) as { evidenceId: string }[];
  for (const row of rows) {
    deleteUnitRow(db, row.evidenceId);
  }
  db.prepare(`DELETE FROM units WHERE kind IN (${placeholders})`).run(...kinds);
}

function restoreImportEdges(db: SqliteDatabase): void {
  db.prepare("DELETE FROM graph_edges WHERE relation = 'IMPORTS'").run();
  const rows = db
    .prepare(
      `SELECT evidence_id AS evidenceId, path AS path, kind AS kind, imports_json AS importsJson, producer AS producer
       FROM units`,
    )
    .all() as {
    evidenceId: GraphUnit["evidenceId"];
    path: string;
    kind: GraphUnit["kind"];
    importsJson: string;
    producer: string;
  }[];
  const units: GraphUnit[] = rows.map((row) => ({
    evidenceId: row.evidenceId,
    path: row.path,
    kind: row.kind,
    imports: JSON.parse(row.importsJson) as string[],
    producer: row.producer,
  }));
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO graph_edges(from_id, to_id, relation, producer) VALUES (?, ?, ?, ?)",
  );
  for (const edge of graphFromUnits(units).filter((item) => item.relation === "IMPORTS")) {
    stmt.run(edge.fromId, edge.toId, edge.relation, edge.producer);
  }
}

async function replaceGitHistory(db: SqliteDatabase, input: IncrementalUpdateInput): Promise<void> {
  deleteUnitsByKinds(db, ["commit", "diff"]);
  if (input.gitHistory === undefined) {
    db.exec("DELETE FROM git_commits; DELETE FROM git_cochange;");
    metaSet(db, "gitHistoryRootDigest", "");
    return;
  }
  const git = await gitUnitsAndEdges(input.gitHistory, input.manifest.snapshotId as SnapshotId, input.getBlob);
  persistGitTables(db, input.gitHistory, git.cochange);
  persistIndex(db, [], git.units, git.edges, { skipVectors: true });
  metaSet(db, "gitHistoryRootDigest", input.gitHistory.historyRootDigest);
}

export async function incrementallyUpdateIndex(input: IncrementalUpdateInput): Promise<RebuildIndexResult> {
  const probe = openIndexDatabase(input.dbPath);
  const storedTool = metaGet(probe, "toolchainDigest");
  const storedSnapshot = metaGet(probe, "snapshotId");
  const storedRevision = metaGet(probe, "indexRevision");
  const storedGit = metaGet(probe, "gitHistoryRootDigest");
  probe.close();
  const tool = toolchainDigest();
  if (storedTool !== tool || storedSnapshot !== input.manifest.snapshotId) {
    return rebuildSnapshotIndex(input);
  }
  const previous = fileDigestMap(input.previousManifest.entries);
  const next = fileDigestMap(input.manifest.entries);
  const changed = changedPaths(previous, next);
  const expected = indexRevisionDigest({
    snapshotId: input.manifest.snapshotId,
    snapshotRootDigest: input.manifest.rootDigest,
    toolchainDigest: tool,
    gitHistoryRootDigest: input.gitHistory?.historyRootDigest,
  });
  const gitDigest = input.gitHistory?.historyRootDigest ?? "";
  if (changed.size === 0) {
    if (storedRevision !== expected) {
      return rebuildSnapshotIndex(input);
    }
    const db = openIndexDatabase(input.dbPath);
    try {
      const evidenceRows = db.prepare("SELECT evidence_id AS id FROM units ORDER BY path, byte_start, kind").all() as {
        id: string;
      }[];
      const fileCount = (db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n;
      return {
        indexRevision: expected,
        toolchainDigest: tool,
        evidenceIds: evidenceRows.map((row) => row.id as RebuildIndexResult["evidenceIds"][number]),
        unitCount: evidenceRows.length,
        fileCount,
        dbPath: input.dbPath,
      };
    } finally {
      db.close();
    }
  }
  if (changed.size * 2 >= Math.max(1, next.size)) {
    return rebuildSnapshotIndex(input);
  }
  const subsetEntries = input.manifest.entries.filter(
    (entry) => entry.entryType === "file" && changed.has(entry.path),
  );
  const ingested = await ingestSnapshotFiles({
    ...input,
    manifest: { ...input.manifest, entries: subsetEntries },
  });
  const db = openIndexDatabase(input.dbPath);
  try {
    for (const path of changed) {
      deletePath(db, path);
    }
    const newFiles = ingested.files.filter((file) => file.entryType === "file" && changed.has(file.path));
    const newUnits = ingested.units.filter((unit) => changed.has(unit.path));
    persistIndex(db, newFiles, newUnits, ingested.edges, { skipVectors: true });
    if (storedGit !== gitDigest) {
      await replaceGitHistory(db, input);
    }
    restoreImportEdges(db);
    reembedAllVectors(db);
    metaSet(db, "snapshotRootDigest", input.manifest.rootDigest);
    metaSet(db, "indexRevision", expected);
    const evidenceRows = db.prepare("SELECT evidence_id AS id FROM units ORDER BY path, byte_start, kind").all() as {
      id: string;
    }[];
    const fileCount = (db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n;
    return {
      indexRevision: expected,
      toolchainDigest: tool,
      evidenceIds: evidenceRows.map((row) => row.id as RebuildIndexResult["evidenceIds"][number]),
      unitCount: evidenceRows.length,
      fileCount,
      dbPath: input.dbPath,
    };
  } finally {
    db.close();
  }
}

export function needsFullRebuild(input: {
  storedToolchainDigest: string | undefined;
  storedSnapshotId: string | undefined;
  snapshotId: string;
}): boolean {
  return input.storedToolchainDigest !== toolchainDigest() || input.storedSnapshotId !== input.snapshotId;
}
