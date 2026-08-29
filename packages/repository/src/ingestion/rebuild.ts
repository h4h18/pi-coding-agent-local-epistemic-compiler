import type { EvidenceId, SnapshotEntry, SnapshotId } from "@pi-hec/contracts";
import { gitUnitsAndEdges } from "../git/history.js";
import { graphFromUnits } from "../graph/edges.js";
import { enrichWithTreeSitter } from "../graph/tree-sitter.js";
import { indexUnitFts } from "../fts/search.js";
import {
  clearIndexTables,
  metaSet,
  openIndexDatabase,
  type SqliteDatabase,
} from "../index-db.js";
import { insertUnitVector } from "../vector/store.js";
import { classifyFile } from "./discovery.js";
import { INDEX_LIMITS, LimitError, assertWithinBudget } from "./limits.js";
import { guessLanguage } from "./language.js";
import { indexRevisionDigest, toolchainDigest } from "./revision.js";
import { loadSnapshotFileBytes } from "./snapshot-bytes.js";
import { validateUntrustedIndex, type UntrustedIndexResult } from "./scip.js";
import { decodeUtf8, isBinaryBytes } from "./text.js";
import type {
  GraphEdgeRecord,
  IndexedFile,
  IndexUnit,
  RebuildIndexInput,
  RebuildIndexResult,
} from "./types.js";

function compareUtf8(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function insertFile(db: SqliteDatabase, file: IndexedFile): void {
  db.prepare(
    `INSERT INTO files(path, entry_type, content_digest, size, language, is_binary, is_generated, category, interface_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    file.path,
    file.entryType,
    file.contentDigest ?? null,
    file.size,
    file.language,
    file.isBinary ? 1 : 0,
    file.isGenerated ? 1 : 0,
    file.category,
    file.interfaceFingerprint,
  );
}

function insertUnit(db: SqliteDatabase, unit: IndexUnit, embed: boolean): number {
  const result = db.prepare(
    `INSERT INTO units(
       evidence_id, path, kind, symbol_id, parent_hierarchy, byte_start, byte_end, line_start, line_end,
       content_digest, language, snapshot_id, imports_json, exports_json, text, producer, interface_fingerprint
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    unit.evidenceId,
    unit.path,
    unit.kind,
    unit.symbolId,
    JSON.stringify(unit.parentHierarchy),
    unit.byteStart,
    unit.byteEnd,
    unit.lineStart,
    unit.lineEnd,
    unit.contentDigest,
    unit.language,
    unit.snapshotId,
    JSON.stringify(unit.imports),
    JSON.stringify(unit.exports),
    unit.text,
    unit.producer,
    unit.interfaceFingerprint,
  );
  const rowid = Number(result.lastInsertRowid);
  indexUnitFts(db, unit.evidenceId, unit.path, unit.symbolId, unit.text);
  if (embed) {
    insertUnitVector(db, rowid, unit.text, unit.language);
  }
  return rowid;
}

function insertEdges(db: SqliteDatabase, edges: readonly GraphEdgeRecord[]): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO graph_edges(from_id, to_id, relation, producer) VALUES (?, ?, ?, ?)",
  );
  for (const edge of edges) {
    stmt.run(edge.fromId, edge.toId, edge.relation, edge.producer);
  }
}

function scipReferenceEdges(validated: UntrustedIndexResult, units: readonly IndexUnit[]): GraphEdgeRecord[] {
  const byPath = new Map<string, IndexUnit[]>();
  for (const unit of units) {
    const list = byPath.get(unit.path) ?? [];
    list.push(unit);
    byPath.set(unit.path, list);
  }
  const edges: GraphEdgeRecord[] = [];
  for (const symbol of validated.symbols) {
    const group = byPath.get(symbol.path);
    if (group === undefined) {
      continue;
    }
    const fileUnit = group.find((unit) => unit.kind === "file");
    const symbolUnit = group.find(
      (unit) =>
        unit.kind !== "file" &&
        (unit.symbolId === symbol.symbol || unit.symbolId.endsWith(`#${symbol.symbol}`)),
    );
    if (fileUnit === undefined || symbolUnit === undefined) {
      continue;
    }
    if (fileUnit.evidenceId === symbolUnit.evidenceId) {
      continue;
    }
    edges.push({
      fromId: fileUnit.evidenceId,
      toId: symbolUnit.evidenceId,
      relation: "REFERENCES",
      producer: symbol.producer,
    });
  }
  return edges;
}

export async function ingestSnapshotFiles(input: RebuildIndexInput): Promise<{
  files: IndexedFile[];
  units: IndexUnit[];
  edges: GraphEdgeRecord[];
}> {
  const files: IndexedFile[] = [];
  const units: IndexUnit[] = [];
  const extraEdges: GraphEdgeRecord[] = [];
  const snapshotId = input.manifest.snapshotId as SnapshotId;
  const entries = [...input.manifest.entries].sort((left, right) => compareUtf8(left.path, right.path));
  const snapshotPaths = entries.map((entry) => entry.path);
  const directoryPaths = entries.filter((entry) => entry.entryType === "directory").map((entry) => entry.path);
  const pendingScip: { kind: "scip" | "lsp"; bytes: Uint8Array }[] = [];
  const ingestStarted = Date.now();
  let outputBytes = 0;
  for (const entry of entries) {
    assertWithinBudget(ingestStarted, `ingest ${entry.path}`);
    switch (entry.entryType) {
      case "directory":
        files.push({
          path: entry.path,
          entryType: "directory",
          contentDigest: undefined,
          size: 0,
          language: "directory",
          isBinary: false,
          isGenerated: false,
          category: "other",
          interfaceFingerprint: "",
        });
        break;
      case "symlink":
      case "submodule":
        files.push({
          path: entry.path,
          entryType: entry.entryType,
          contentDigest: undefined,
          size: 0,
          language: entry.entryType,
          isBinary: false,
          isGenerated: false,
          category: "other",
          interfaceFingerprint: "",
        });
        break;
      case "file": {
        const bytes = await loadSnapshotFileBytes(entry, input.getBlob);
        const binary = isBinaryBytes(bytes) || bytes.byteLength > INDEX_LIMITS.maxFileBytes;
        const text = binary ? undefined : decodeUtf8(bytes);
        const language = guessLanguage(entry.path, text);
        const category = classifyFile(entry.path, text, binary || text === undefined);
        const file: IndexedFile = {
          path: entry.path,
          entryType: "file",
          contentDigest: entry.contentDigest,
          size: entry.size,
          language,
          isBinary: binary || text === undefined,
          isGenerated: category === "generated",
          category,
          interfaceFingerprint: "",
        };
        files.push(file);
        if (text !== undefined && !file.isBinary) {
          const enriched = await enrichWithTreeSitter({
            path: entry.path,
            text,
            language,
            snapshotId,
            category,
            ...(input.grammarWasm !== undefined ? { grammarWasm: input.grammarWasm } : {}),
          });
          units.push(...enriched.units);
          for (const unit of enriched.units) {
            outputBytes += Buffer.byteLength(unit.text, "utf8");
          }
          if (outputBytes > INDEX_LIMITS.maxOutputBytes) {
            throw new LimitError("index exceeded output byte budget");
          }
          file.interfaceFingerprint = enriched.units.find((unit) => unit.kind === "file")?.interfaceFingerprint ?? "";
          if (
            (entry.path.endsWith(".scip.json") || entry.path.endsWith("index.scip.json") || entry.path.endsWith(".lsp.json")) &&
            text.startsWith("{")
          ) {
            pendingScip.push({
              kind: entry.path.includes("lsp") ? "lsp" : "scip",
              bytes,
            });
          }
        }
        break;
      }
      default: {
        const exhaustive: never = entry;
        throw new Error(`unhandled snapshot entry ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  for (const item of pendingScip) {
    const validated = validateUntrustedIndex({
      kind: item.kind,
      bytes: item.bytes,
      snapshotPaths,
      directoryPaths,
    });
    extraEdges.push(...scipReferenceEdges(validated, units));
  }
  if (units.length > INDEX_LIMITS.maxTotalUnits) {
    throw new LimitError("index exceeded max units");
  }
  assertWithinBudget(ingestStarted, "ingest snapshot");
  return { files, units, edges: extraEdges };
}

export function persistIndex(
  db: SqliteDatabase,
  files: readonly IndexedFile[],
  units: readonly IndexUnit[],
  edges: readonly GraphEdgeRecord[],
  options: { skipVectors?: boolean } = {},
): void {
  const embed = options.skipVectors !== true;
  for (const file of files) {
    insertFile(db, file);
  }
  const sortedUnits = [...units].sort((left, right) => {
    const pathCmp = compareUtf8(left.path, right.path);
    if (pathCmp !== 0) {
      return pathCmp;
    }
    if (left.byteStart !== right.byteStart) {
      return left.byteStart - right.byteStart;
    }
    return compareUtf8(left.kind, right.kind);
  });
  for (const unit of sortedUnits) {
    insertUnit(db, unit, embed);
  }
  insertEdges(db, [...edges, ...graphFromUnits(sortedUnits)]);
}

export function persistGitTables(
  db: SqliteDatabase,
  history: NonNullable<RebuildIndexInput["gitHistory"]>,
  cochange: ReadonlyMap<string, number>,
): void {
  db.exec("DELETE FROM git_commits; DELETE FROM git_cochange;");
  const co = db.prepare("INSERT INTO git_cochange(path_a, path_b, commit_count) VALUES (?, ?, ?)");
  for (const [key, count] of cochange) {
    const split = key.split("\0");
    const left = split[0];
    const right = split[1];
    if (left !== undefined && right !== undefined) {
      co.run(left, right, count);
    }
  }
  const commitStmt = db.prepare(
    "INSERT INTO git_commits(object_id, parent_object_ids_json, author_timestamp, message_digest, changed_paths_json) VALUES (?, ?, ?, ?, ?)",
  );
  for (const commit of history.commits) {
    commitStmt.run(
      commit.objectId,
      JSON.stringify(commit.parentObjectIds),
      commit.authorTimestamp,
      commit.messageDigest,
      JSON.stringify(commit.changedPaths),
    );
  }
}

export async function rebuildSnapshotIndex(input: RebuildIndexInput): Promise<RebuildIndexResult> {
  const db = openIndexDatabase(input.dbPath);
  try {
    clearIndexTables(db);
    const ingested = await ingestSnapshotFiles(input);
    let gitUnits: IndexUnit[] = [];
    const gitEdges: GraphEdgeRecord[] = [];
    if (input.gitHistory !== undefined) {
      const git = await gitUnitsAndEdges(input.gitHistory, input.manifest.snapshotId as SnapshotId, input.getBlob);
      gitUnits = git.units;
      persistGitTables(db, input.gitHistory, git.cochange);
    }
    persistIndex(db, ingested.files, [...ingested.units, ...gitUnits], [...ingested.edges, ...gitEdges]);
    const tool = toolchainDigest();
    const revision = indexRevisionDigest({
      snapshotId: input.manifest.snapshotId,
      snapshotRootDigest: input.manifest.rootDigest,
      toolchainDigest: tool,
      gitHistoryRootDigest: input.gitHistory?.historyRootDigest,
    });
    metaSet(db, "snapshotId", input.manifest.snapshotId);
    metaSet(db, "snapshotRootDigest", input.manifest.rootDigest);
    metaSet(db, "toolchainDigest", tool);
    metaSet(db, "indexRevision", revision);
    metaSet(db, "gitHistoryRootDigest", input.gitHistory?.historyRootDigest ?? "");
    const evidenceRows = db.prepare("SELECT evidence_id AS id FROM units ORDER BY path, byte_start, kind").all() as {
      id: string;
    }[];
    return {
      indexRevision: revision,
      toolchainDigest: tool,
      evidenceIds: evidenceRows.map((row) => row.id as EvidenceId),
      unitCount: evidenceRows.length,
      fileCount: ingested.files.length,
      dbPath: input.dbPath,
    };
  } finally {
    db.close();
  }
}

export function listEvidenceIds(dbPath: string): string[] {
  const db = openIndexDatabase(dbPath);
  try {
    const rows = db.prepare("SELECT evidence_id AS id FROM units ORDER BY path, byte_start, kind").all() as {
      id: string;
    }[];
    return rows.map((row) => row.id);
  } finally {
    db.close();
  }
}

export type { SnapshotEntry };
