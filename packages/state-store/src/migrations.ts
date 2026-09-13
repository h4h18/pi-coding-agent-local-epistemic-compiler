import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_ROLE_REGISTRY,
  OPERATION_KINDS,
  RECLAIMABLE_OPERATION_KINDS,
  RUN_STATES,
  artifactRoleRegistrySql,
  operationKindRegistrySql,
  runStateRegistrySql,
} from "@pi-hec/domain";
import { isRecord, requiredInt, requiredString, rowOf } from "./rows.js";
import type { SqliteDatabase } from "./sqlite.js";

export const INITIAL_MIGRATION_NAME = "0001_initial";
export const INITIAL_MIGRATION_VERSION = 1;

export function defaultControlMigrationsDir(): string {
  return path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../migrations/control");
}

export function migrationFilePath(migrationsDir: string): string {
  return path.join(migrationsDir, "0001_initial.sql");
}

export function checksumSqlBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function loadMigrationSql(migrationsDir: string): {
  sql: string;
  bytes: Buffer;
  checksum: string;
} {
  const bytes = readFileSync(migrationFilePath(migrationsDir));
  return { sql: bytes.toString("utf8"), bytes, checksum: checksumSqlBytes(bytes) };
}

function tableExists(db: SqliteDatabase, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

export const MULTI_AGENT_MIGRATION_NAME = "0002_multi_agent";
export const MULTI_AGENT_MIGRATION_VERSION = 2;

export function multiAgentMigrationFilePath(migrationsDir: string): string {
  return path.join(migrationsDir, "0002_multi_agent.sql");
}

export function applyMultiAgentMigration(
  db: SqliteDatabase,
  migrationsDir: string,
  appliedAt: string,
): void {
  if (!tableExists(db, "agent_nodes")) {
    const bytes = readFileSync(multiAgentMigrationFilePath(migrationsDir));
    db.exec(bytes.toString("utf8"));
    db.prepare(
      "INSERT OR IGNORE INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    ).run(
      MULTI_AGENT_MIGRATION_VERSION,
      MULTI_AGENT_MIGRATION_NAME,
      checksumSqlBytes(bytes),
      appliedAt,
    );
  }
  syncContractRegistries(db);
}

export function applyInitialMigration(
  db: SqliteDatabase,
  migrationsDir: string,
  appliedAt: string,
): { checksum: string } {
  const loaded = loadMigrationSql(migrationsDir);
  db.pragma("foreign_keys = OFF");
  db.exec(loaded.sql);
  db.exec(runStateRegistrySql());
  db.exec(operationKindRegistrySql());
  db.exec(artifactRoleRegistrySql());
  db.prepare(
    "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  ).run(INITIAL_MIGRATION_VERSION, INITIAL_MIGRATION_NAME, loaded.checksum, appliedAt);
  applyMultiAgentMigration(db, migrationsDir, appliedAt);
  db.pragma("foreign_keys = ON");
  return { checksum: loaded.checksum };
}

export type SchemaMigrationRow = {
  version: number;
  name: string;
  checksum: string;
  appliedAt: string;
};

export function readSchemaMigration(db: SqliteDatabase): SchemaMigrationRow | undefined {
  if (!tableExists(db, "schema_migrations")) {
    return undefined;
  }
  const row = db
    .prepare("SELECT version, name, checksum, applied_at FROM schema_migrations WHERE version = ?")
    .get(INITIAL_MIGRATION_VERSION);
  if (row === undefined) {
    return undefined;
  }
  const record = rowOf(row, "schema_migrations");
  return {
    version: requiredInt(record, "version"),
    name: requiredString(record, "name"),
    checksum: requiredString(record, "checksum"),
    appliedAt: requiredString(record, "applied_at"),
  };
}

function sortedJoin(values: readonly string[]): string {
  return [...values].sort().join("\n");
}

function expectedRunStates(): string {
  return sortedJoin(RUN_STATES);
}

function expectedOperationKinds(): string {
  return sortedJoin(
    OPERATION_KINDS.map((kind) => `${kind}\t${RECLAIMABLE_OPERATION_KINDS.has(kind) ? "1" : "0"}`),
  );
}

function expectedArtifactRoles(): string {
  return sortedJoin(
    ARTIFACT_ROLE_REGISTRY.map(
      (entry) =>
        `${entry.ownerKind}\t${entry.role}\t${entry.cardinality}\t${entry.artifactSchemaName ?? ""}`,
    ),
  );
}

function columnText(row: unknown, field: string): string {
  if (!isRecord(row)) {
    throw new Error("invalid registry row");
  }
  return requiredString(row, field);
}

export function syncContractRegistries(db: SqliteDatabase): void {
  db.exec(runStateRegistrySql().replace("INSERT INTO", "INSERT OR IGNORE INTO"));
  db.exec(operationKindRegistrySql().replace("INSERT INTO", "INSERT OR IGNORE INTO"));
  db.exec(artifactRoleRegistrySql().replace("INSERT INTO", "INSERT OR IGNORE INTO"));
}

export function registriesMatchContracts(db: SqliteDatabase): boolean {
  if (
    !tableExists(db, "run_state_registry") ||
    !tableExists(db, "operation_kind_registry") ||
    !tableExists(db, "artifact_role_registry")
  ) {
    return false;
  }
  const states = db
    .prepare("SELECT state FROM run_state_registry")
    .all()
    .map((row) => columnText(row, "state"));
  const kinds = db
    .prepare("SELECT operation_kind, reclaimable FROM operation_kind_registry")
    .all()
    .map((row) => {
      if (!isRecord(row)) {
        throw new Error("invalid operation kind row");
      }
      return `${requiredString(row, "operation_kind")}\t${String(requiredInt(row, "reclaimable"))}`;
    });
  const roles = db
    .prepare(
      "SELECT owner_kind, role, cardinality, artifact_schema_name FROM artifact_role_registry",
    )
    .all()
    .map((row) => {
      if (!isRecord(row)) {
        throw new Error("invalid artifact role row");
      }
      const schema = row.artifact_schema_name;
      const schemaText = schema === null ? "" : requiredString(row, "artifact_schema_name");
      return `${requiredString(row, "owner_kind")}\t${requiredString(row, "role")}\t${requiredString(row, "cardinality")}\t${schemaText}`;
    });
  return (
    sortedJoin(states) === expectedRunStates() &&
    sortedJoin(kinds) === expectedOperationKinds() &&
    sortedJoin(roles) === expectedArtifactRoles()
  );
}

export function ensureMigrated(
  db: SqliteDatabase,
  migrationsDir: string,
  appliedAt: string,
): { checksum: string; readOnly: boolean } {
  const loaded = loadMigrationSql(migrationsDir);
  const existing = readSchemaMigration(db);
  if (existing === undefined) {
    const applied = applyInitialMigration(db, migrationsDir, appliedAt);
    return { checksum: applied.checksum, readOnly: !registriesMatchContracts(db) };
  }
  applyMultiAgentMigration(db, migrationsDir, appliedAt);
  const checksumMismatch =
    existing.checksum !== loaded.checksum || existing.name !== INITIAL_MIGRATION_NAME;
  const readOnly = checksumMismatch || !registriesMatchContracts(db);
  return { checksum: existing.checksum, readOnly };
}
