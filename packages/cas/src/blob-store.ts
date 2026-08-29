import type {
  ArtifactStorageRecord,
  DomainDigest,
  ObjectDigest,
} from "@pi-hec/contracts";

export const QUARANTINE_MIN_DAYS = 30;
export const INCOMING_SWEEP_MIN_MS = 60 * 60 * 1000;
export const INCOMING_FILE_MODE = 0o600;

export type EncryptionAlgorithm = ArtifactStorageRecord["encryptionAlgorithm"];
export type ArtifactClassification = ArtifactStorageRecord["classification"];

export type CasErrorCode =
  | "NOT_FOUND"
  | "CORRUPT"
  | "TRUNCATED"
  | "QUARANTINED"
  | "OVERWRITE_REJECTED"
  | "GC_FORBIDDEN"
  | "INVALID_DIGEST"
  | "INVALID_PROJECT_ID"
  | "SIZE_MISMATCH"
  | "INVALID_KEY";

export class CasError extends Error {
  readonly code: CasErrorCode;

  constructor(code: CasErrorCode, message: string) {
    super(message);
    this.name = "CasError";
    this.code = code;
  }
}

export type PutObjectInput = {
  projectId: string;
  bytes: Uint8Array;
  mediaType: string;
  classification: ArtifactClassification;
  schemaName?: string;
  encryptionAlgorithm?: EncryptionAlgorithm;
  securityCritical?: boolean;
};

export type PutObjectResult = {
  objectDigest: ObjectDigest;
  storageRecord: ArtifactStorageRecord;
  storageRecordDigest: DomainDigest<"storage-record">;
  reusedExisting: boolean;
};

export type GetObjectInput = {
  projectId: string;
  objectDigest: ObjectDigest;
  securityCritical?: boolean;
};

export type StorageRecordPersistInput = {
  record: ArtifactStorageRecord;
  storageRecordDigest: DomainDigest<"storage-record">;
};

export interface StorageRecordSink {
  persist(input: StorageRecordPersistInput): Promise<void>;
  get(projectId: string, objectDigest: ObjectDigest): Promise<ArtifactStorageRecord | undefined>;
}

export type UnwrappedDek = {
  keyId: string;
  dek: Uint8Array;
};

export interface KekHook {
  unwrapProjectDek(input: { projectId: string; encryptionKeyId?: string }): Promise<UnwrappedDek> | UnwrappedDek;
}

export interface OccupancyPredicate {
  isGcForbidden(projectId: string, objectDigest: ObjectDigest): Promise<boolean> | boolean;
}

export type CasClock = {
  nowIso: () => string;
  nowMs: () => number;
};

export type FilesystemCasOptions = {
  rootDir: string;
  sink: StorageRecordSink;
  kek: KekHook;
  occupancy?: OccupancyPredicate;
  clock?: CasClock;
  encryptionAlgorithm?: EncryptionAlgorithm;
};

export interface BlobStore {
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
  getObject(input: GetObjectInput): Promise<Uint8Array>;
  objectPath(projectId: string, objectDigest: ObjectDigest): string;
}

export class MemoryStorageRecordSink implements StorageRecordSink {
  readonly records: ArtifactStorageRecord[] = [];

  persist(input: StorageRecordPersistInput): Promise<void> {
    const index = this.records.findIndex(
      (record) =>
        record.projectId === input.record.projectId &&
        record.objectDigest === input.record.objectDigest,
    );
    if (index < 0) {
      this.records.push(input.record);
    }
    return Promise.resolve();
  }

  get(projectId: string, objectDigest: ObjectDigest): Promise<ArtifactStorageRecord | undefined> {
    return Promise.resolve(
      this.records.find(
        (record) => record.projectId === projectId && record.objectDigest === objectDigest,
      ),
    );
  }
}

export function systemClock(): CasClock {
  return {
    nowIso: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  };
}

export function neverOccupied(): OccupancyPredicate {
  return { isGcForbidden: () => false };
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
