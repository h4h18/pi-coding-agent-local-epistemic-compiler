import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type SqliteRunResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

export type SqliteStatement = {
  run: (...params: unknown[]) => SqliteRunResult;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};

export type SqliteTransaction<T> = (() => T) & {
  deferred: () => T;
  immediate: () => T;
};

export type SqliteDatabase = {
  prepare: (source: string) => SqliteStatement;
  exec: (source: string) => SqliteDatabase;
  pragma: (source: string, options?: { simple?: boolean }) => unknown;
  transaction: <T>(fn: () => T) => SqliteTransaction<T>;
  backup: (destinationFile: string) => Promise<{ totalPages: number; remainingPages: number }>;
  close: () => SqliteDatabase;
};

type SqliteConstructor = new (filename: string, options?: { timeout?: number }) => SqliteDatabase;

const Database = require("better-sqlite3") as SqliteConstructor;

export function openSqliteFile(filePath: string): SqliteDatabase {
  return new Database(filePath, { timeout: 5000 });
}

export function applyRuntimePragmas(db: SqliteDatabase): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("trusted_schema = OFF");
  db.pragma("busy_timeout = 5000");
  db.pragma("locking_mode = NORMAL");
}

export type SqlitePragmas = {
  journal_mode: "wal";
  synchronous: "FULL";
  foreign_keys: "ON";
  trusted_schema: "OFF";
  busy_timeout: 5000;
  locking_mode: "NORMAL";
};

function pragmaValue(db: SqliteDatabase, name: string): unknown {
  return db.pragma(name, { simple: true });
}

function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  throw new Error(`unexpected pragma value ${JSON.stringify(value)}`);
}

export function readRuntimePragmas(db: SqliteDatabase): SqlitePragmas {
  const journal = asText(pragmaValue(db, "journal_mode")).toLowerCase();
  if (journal !== "wal") {
    throw new Error(`journal_mode is ${journal}`);
  }
  const synchronousRaw = pragmaValue(db, "synchronous");
  const synchronous =
    synchronousRaw === 2 || asText(synchronousRaw).toUpperCase() === "FULL" ? "FULL" : undefined;
  if (synchronous !== "FULL") {
    throw new Error(`synchronous is ${asText(synchronousRaw)}`);
  }
  const foreignRaw = pragmaValue(db, "foreign_keys");
  if (foreignRaw !== 1 && asText(foreignRaw).toUpperCase() !== "ON") {
    throw new Error(`foreign_keys is ${asText(foreignRaw)}`);
  }
  const trustedRaw = pragmaValue(db, "trusted_schema");
  if (trustedRaw !== 0 && asText(trustedRaw).toUpperCase() !== "OFF") {
    throw new Error(`trusted_schema is ${asText(trustedRaw)}`);
  }
  const timeoutRaw = pragmaValue(db, "busy_timeout");
  const timeout = typeof timeoutRaw === "number" ? timeoutRaw : Number.parseInt(asText(timeoutRaw), 10);
  if (timeout !== 5000) {
    throw new Error(`busy_timeout is ${String(timeoutRaw)}`);
  }
  const locking = asText(pragmaValue(db, "locking_mode")).toUpperCase();
  if (locking !== "NORMAL") {
    throw new Error(`locking_mode is ${locking}`);
  }
  return {
    journal_mode: "wal",
    synchronous: "FULL",
    foreign_keys: "ON",
    trusted_schema: "OFF",
    busy_timeout: 5000,
    locking_mode: "NORMAL",
  };
}
