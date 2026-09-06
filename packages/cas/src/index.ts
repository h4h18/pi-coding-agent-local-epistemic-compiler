export const packageName = "@pi-hec/cas";

export {
  CasError,
  MemoryStorageRecordSink,
  INCOMING_SWEEP_MIN_MS,
  QUARANTINE_MIN_DAYS,
  neverOccupied,
  systemClock,
} from "./blob-store.js";
export type {
  ArtifactClassification,
  BlobStore,
  CasClock,
  CasErrorCode,
  EncryptionAlgorithm,
  FilesystemCasOptions,
  GetObjectInput,
  KekHook,
  OccupancyPredicate,
  PutObjectInput,
  PutObjectResult,
  StorageRecordPersistInput,
  StorageRecordSink,
  UnwrappedDek,
} from "./blob-store.js";
export { FilesystemCas, createFilesystemCas } from "./filesystem-cas.js";
export {
  createCasLayout,
  listStoredHex,
  markUnreachableObjects,
  sweepQuarantineObjects,
} from "./gc.js";
export { digestPlaintext, encodeAad, storageRecordDigest, storageRecordJson } from "./integrity.js";
