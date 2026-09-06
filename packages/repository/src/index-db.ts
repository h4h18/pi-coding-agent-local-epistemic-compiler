import { createRequire } from "node:module";
import { load as loadSqliteVec } from "sqlite-vec";
import { INDEX_TOOLCHAIN } from "./ingestion/types.js";

export type SqliteRunResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

export type SqliteStatement = {
  run: (...params: unknown[]) => SqliteRunResult;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};

export type SqliteDatabase = {
  prepare: (source: string) => SqliteStatement;
  exec: (source: string) => SqliteDatabase;
  pragma: (source: string, options?: { simple?: boolean }) => unknown;
  loadExtension: (file: string) => SqliteDatabase;
  close: () => SqliteDatabase;
};

type SqliteConstructor = new (filename: string, options?: { timeout?: number }) => SqliteDatabase;

const Database = createRequire(import.meta.url)("better-sqlite3") as SqliteConstructor;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;

CREATE TABLE IF NOT EXISTS index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  entry_type TEXT NOT NULL,
  content_digest TEXT,
  size INTEGER NOT NULL,
  language TEXT NOT NULL,
  is_binary INTEGER NOT NULL,
  is_generated INTEGER NOT NULL,
  category TEXT NOT NULL,
  interface_fingerprint TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY,
  evidence_id TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  symbol_id TEXT NOT NULL,
  parent_hierarchy TEXT NOT NULL,
  byte_start INTEGER NOT NULL,
  byte_end INTEGER NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  content_digest TEXT NOT NULL,
  language TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  imports_json TEXT NOT NULL,
  exports_json TEXT NOT NULL,
  text TEXT NOT NULL,
  producer TEXT NOT NULL,
  interface_fingerprint TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS units_path ON units(path);
CREATE INDEX IF NOT EXISTS units_digest ON units(content_digest);

CREATE VIRTUAL TABLE IF NOT EXISTS units_fts USING fts5(
  evidence_id UNINDEXED,
  path,
  symbol_id,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS lexical_tokens (
  token_folded TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  PRIMARY KEY (token_folded, evidence_id)
);

CREATE TABLE IF NOT EXISTS graph_edges (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  producer TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, relation, producer)
);

CREATE TABLE IF NOT EXISTS git_commits (
  object_id TEXT PRIMARY KEY,
  parent_object_ids_json TEXT NOT NULL,
  author_timestamp TEXT NOT NULL,
  message_digest TEXT NOT NULL,
  changed_paths_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS git_cochange (
  path_a TEXT NOT NULL,
  path_b TEXT NOT NULL,
  commit_count INTEGER NOT NULL,
  PRIMARY KEY (path_a, path_b)
);
`;

function ensureVecTable(db: SqliteDatabase): void {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'units_vec'")
    .get() as { name: string } | undefined;
  if (row !== undefined) {
    return;
  }
  db.exec(
    `CREATE VIRTUAL TABLE units_vec USING vec0(
      embedding float[${String(INDEX_TOOLCHAIN.vectorDimensions)}],
      language TEXT
    );`,
  );
}

export function openIndexDatabase(filePath: string): SqliteDatabase {
  const db = new Database(filePath, { timeout: 5000 });
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("trusted_schema = OFF");
  loadSqliteVec(db);
  db.exec(SCHEMA);
  ensureVecTable(db);
  return db;
}

export function metaGet(db: SqliteDatabase, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM index_meta WHERE key = ?").get(key) as
    { value: string } | undefined;
  return row?.value;
}

export function metaSet(db: SqliteDatabase, key: string, value: string): void {
  db.prepare(
    "INSERT INTO index_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function clearIndexTables(db: SqliteDatabase): void {
  db.exec(`
    DELETE FROM lexical_tokens;
    DELETE FROM graph_edges;
    DELETE FROM git_cochange;
    DELETE FROM git_commits;
    DELETE FROM units_fts;
    DELETE FROM units;
    DELETE FROM files;
    DROP TABLE IF EXISTS units_vec;
  `);
  ensureVecTable(db);
}
