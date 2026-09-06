import { randomUUID, timingSafeEqual } from "node:crypto";
import { constants, copyFile, link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { Compile } from "typebox/compile";
import { ObjectDigestSchema, ProjectIdSchema } from "@pi-hec/contracts";
import type { ArtifactStorageRecord, ObjectDigest } from "@pi-hec/contracts";
import { CasError, INCOMING_FILE_MODE, isNodeError, systemClock } from "./blob-store.js";
import type {
  CasClock,
  FilesystemCasOptions,
  GetObjectInput,
  KekHook,
  OccupancyPredicate,
  PutObjectInput,
  PutObjectResult,
  StorageRecordSink,
  UnwrappedDek,
} from "./blob-store.js";
import {
  createCasLayout,
  digestToHex,
  markUnreachableObjects,
  moveToQuarantine,
  sweepQuarantineObjects,
} from "./gc.js";
import type { CasLayout } from "./gc.js";
import {
  absorbDummyAead,
  decryptCiphertext,
  digestPlaintext,
  encodeAad,
  encodeBlob,
  encryptPlaintext,
  nonceToBase64,
  parseBlob,
  randomNonce,
  storageRecordDigest,
} from "./integrity.js";
import type { AadFields } from "./integrity.js";

const PROJECT_ID = Compile(ProjectIdSchema);
const OBJECT_DIGEST = Compile(ObjectDigestSchema);

export class FilesystemCas {
  private readonly layout: CasLayout;
  private readonly sink: StorageRecordSink;
  private readonly kek: KekHook;
  private readonly occupancy: OccupancyPredicate | undefined;
  private readonly clock: CasClock;
  private readonly defaultAlgorithm: PutObjectInput["encryptionAlgorithm"];
  private readonly lockWaiters = new Map<string, Promise<unknown>>();
  private readonly heldLocks = new Set<string>();
  private readonly inFlightIncoming = new Set<string>();

  constructor(options: FilesystemCasOptions) {
    if (options.rootDir.length === 0) {
      throw new CasError("INVALID_PROJECT_ID", "CAS rootDir must be non-empty");
    }
    this.layout = createCasLayout(options.rootDir);
    this.sink = options.sink;
    this.kek = options.kek;
    this.occupancy = options.occupancy;
    this.clock = options.clock ?? systemClock();
    this.defaultAlgorithm = options.encryptionAlgorithm ?? "AES-256-GCM";
  }

  objectPath(projectId: string, objectDigest: ObjectDigest): string {
    return this.layout.objectPath(
      assertProjectId(projectId),
      digestToHex(assertObjectDigest(objectDigest)),
    );
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const projectId = assertProjectId(input.projectId);
    const objectDigest = digestPlaintext(input.bytes);
    return this.withLock(`${projectId}\0${objectDigest}`, () =>
      this.putLocked(projectId, objectDigest, input),
    );
  }

  async getObject(input: GetObjectInput): Promise<Uint8Array> {
    const projectId = assertProjectId(input.projectId);
    const objectDigest = assertObjectDigest(input.objectDigest);
    return this.withLock(`${projectId}\0${objectDigest}`, () =>
      this.getLocked(projectId, objectDigest),
    );
  }

  async markUnreachable(projectId: string, reachable: ReadonlySet<ObjectDigest>): Promise<void> {
    await markUnreachableObjects({
      layout: this.layout,
      projectId: assertProjectId(projectId),
      reachable,
      occupancy: this.requireOccupancy(),
      clock: this.clock,
    });
  }

  async sweepQuarantine(projectId: string): Promise<void> {
    const id = assertProjectId(projectId);
    await sweepQuarantineObjects({
      layout: this.layout,
      projectId: id,
      occupancy: this.requireOccupancy(),
      clock: this.clock,
      skipIncoming: this.hasProjectLock(id),
      protectedIncoming: this.inFlightIncoming,
    });
  }

  private async putLocked(
    projectId: string,
    objectDigest: ObjectDigest,
    input: PutObjectInput,
  ): Promise<PutObjectResult> {
    const dest = this.layout.objectPath(projectId, digestToHex(objectDigest));
    const existing = await this.readVerified(projectId, objectDigest, dest);
    if (existing !== undefined) {
      const record = await this.recordFor(projectId, objectDigest, input, existing.parsed);
      return {
        objectDigest,
        storageRecord: record.storageRecord,
        storageRecordDigest: record.storageRecordDigest,
        reusedExisting: true,
      };
    }
    const algorithm = input.encryptionAlgorithm ?? this.defaultAlgorithm ?? "AES-256-GCM";
    const unwrapped = await Promise.resolve(this.kek.unwrapProjectDek({ projectId }));
    const nonce = randomNonce(algorithm);
    const aad = encodeAad(aadFieldsFromPut(projectId, objectDigest, input));
    const ciphertext = encryptPlaintext(algorithm, unwrapped.dek, nonce, aad, input.bytes);
    const blob = encodeBlob({
      algorithm,
      keyId: unwrapped.keyId,
      nonce,
      aad,
      ciphertext,
    });
    const incoming = await this.writeIncoming(projectId, blob);
    try {
      await this.verifyStagedIncoming(incoming, objectDigest, unwrapped);
      const installed = await exclusiveInstall(incoming, dest);
      if (installed === "exists") {
        await unlinkQuiet(incoming);
        const verified = await this.readVerified(projectId, objectDigest, dest);
        if (verified !== undefined) {
          const record = await this.recordFor(projectId, objectDigest, input, verified.parsed);
          return {
            objectDigest,
            storageRecord: record.storageRecord,
            storageRecordDigest: record.storageRecordDigest,
            reusedExisting: true,
          };
        }
        await this.quarantineHex(projectId, digestToHex(objectDigest));
        throw new CasError("CORRUPT", "existing object digest mismatch; quarantined");
      }
      const storageRecord = buildStorageRecord({
        projectId,
        objectDigest,
        input,
        keyId: unwrapped.keyId,
        algorithm,
        nonce,
        createdAt: this.clock.nowIso(),
      });
      const digest = storageRecordDigest(storageRecord);
      await this.sink.persist({ record: storageRecord, storageRecordDigest: digest });
      if (input.securityCritical === true) {
        await this.getLocked(projectId, objectDigest);
      }
      return {
        objectDigest,
        storageRecord,
        storageRecordDigest: digest,
        reusedExisting: false,
      };
    } catch (error) {
      await unlinkQuiet(incoming);
      throw error;
    } finally {
      this.inFlightIncoming.delete(incoming);
    }
  }

  private async getLocked(projectId: string, objectDigest: ObjectDigest): Promise<Uint8Array> {
    const dest = this.layout.objectPath(projectId, digestToHex(objectDigest));
    const verified = await this.readVerified(projectId, objectDigest, dest);
    if (verified === undefined) {
      const unwrapped = await Promise.resolve(this.kek.unwrapProjectDek({ projectId }));
      absorbDummyAead(unwrapped.dek);
      if (!(await pathIsFile(dest))) {
        throw new CasError("NOT_FOUND", "object not found");
      }
      await this.quarantineHex(projectId, digestToHex(objectDigest));
      throw new CasError("NOT_FOUND", "object not found");
    }
    return verified.plaintext;
  }

  private async readVerified(
    projectId: string,
    objectDigest: ObjectDigest,
    dest: string,
  ): Promise<
    | {
        plaintext: Uint8Array;
        parsed: ReturnType<typeof parseBlob>;
        unwrapped: UnwrappedDek;
      }
    | undefined
  > {
    if (!(await pathIsFile(dest))) {
      return undefined;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(dest);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    try {
      const parsed = parseBlob(bytes);
      const dek = await Promise.resolve(
        this.kek.unwrapProjectDek({ projectId, encryptionKeyId: parsed.keyId }),
      );
      if (dek.keyId !== parsed.keyId) {
        throw new CasError(
          "INVALID_KEY",
          "unwrapped DEK key id does not match blob encryptionKeyId",
        );
      }
      const plaintext = decryptCiphertext(
        parsed.algorithm,
        dek.dek,
        parsed.nonce,
        parsed.aad,
        parsed.ciphertext,
      );
      if (!digestsMatch(digestPlaintext(plaintext), objectDigest)) {
        throw new CasError("CORRUPT", "plaintext digest mismatch");
      }
      return { plaintext, parsed, unwrapped: dek };
    } catch (error) {
      if (error instanceof CasError && (error.code === "CORRUPT" || error.code === "TRUNCATED")) {
        await this.quarantineHex(projectId, digestToHex(objectDigest));
        return undefined;
      }
      throw error;
    }
  }

  private async recordFor(
    projectId: string,
    objectDigest: ObjectDigest,
    input: PutObjectInput,
    parsed: ReturnType<typeof parseBlob>,
  ): Promise<{
    storageRecord: ArtifactStorageRecord;
    storageRecordDigest: ReturnType<typeof storageRecordDigest>;
  }> {
    const existing = await this.sink.get(projectId, objectDigest);
    if (existing !== undefined) {
      return { storageRecord: existing, storageRecordDigest: storageRecordDigest(existing) };
    }
    const storageRecord = buildStorageRecord({
      projectId,
      objectDigest,
      input,
      keyId: parsed.keyId,
      algorithm: parsed.algorithm,
      nonce: parsed.nonce,
      createdAt: this.clock.nowIso(),
    });
    const digest = storageRecordDigest(storageRecord);
    await this.sink.persist({ record: storageRecord, storageRecordDigest: digest });
    return { storageRecord, storageRecordDigest: digest };
  }

  private async writeIncoming(projectId: string, blob: Uint8Array): Promise<string> {
    const dir = this.layout.incomingDir(projectId);
    await mkdir(dir, { recursive: true });
    const incoming = path.join(dir, randomUUID());
    this.inFlightIncoming.add(incoming);
    try {
      const handle = await open(
        incoming,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        INCOMING_FILE_MODE,
      );
      try {
        await handle.writeFile(blob);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return incoming;
    } catch (error) {
      this.inFlightIncoming.delete(incoming);
      await unlinkQuiet(incoming);
      throw error;
    }
  }

  private async verifyStagedIncoming(
    incoming: string,
    objectDigest: ObjectDigest,
    unwrapped: UnwrappedDek,
  ): Promise<void> {
    const bytes = await readFile(incoming);
    const parsed = parseBlob(bytes);
    const plaintext = decryptCiphertext(
      parsed.algorithm,
      unwrapped.dek,
      parsed.nonce,
      parsed.aad,
      parsed.ciphertext,
    );
    if (!digestsMatch(digestPlaintext(plaintext), objectDigest)) {
      throw new CasError("CORRUPT", "incoming plaintext digest mismatch");
    }
  }

  private requireOccupancy(): OccupancyPredicate {
    if (this.occupancy === undefined) {
      throw new CasError("GC_FORBIDDEN", "FilesystemCas occupancy predicate is required for GC");
    }
    return this.occupancy;
  }

  private hasProjectLock(projectId: string): boolean {
    const prefix = `${projectId}\0`;
    for (const key of this.heldLocks) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  private async quarantineHex(projectId: string, hex: string): Promise<void> {
    await moveToQuarantine(this.layout, projectId, hex, this.clock.nowIso().slice(0, 10));
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.lockWaiters.get(key) ?? Promise.resolve();
    let release: (value: unknown) => void = () => {
      return;
    };
    const gate = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const waiter = prior.then(() => gate);
    this.lockWaiters.set(key, waiter);
    await prior.then(
      () => undefined,
      () => undefined,
    );
    this.heldLocks.add(key);
    try {
      return await fn();
    } finally {
      this.heldLocks.delete(key);
      release(undefined);
      if (this.lockWaiters.get(key) === waiter) {
        this.lockWaiters.delete(key);
      }
    }
  }
}

export function createFilesystemCas(options: FilesystemCasOptions): FilesystemCas {
  return new FilesystemCas(options);
}

function aadFieldsFromPut(
  projectId: string,
  objectDigest: ObjectDigest,
  input: PutObjectInput,
): AadFields {
  const fields: AadFields = {
    projectId,
    objectDigest,
    mediaType: input.mediaType,
    byteSize: input.bytes.byteLength,
  };
  if (input.schemaName !== undefined) {
    fields.schemaName = input.schemaName;
  }
  return fields;
}

function buildStorageRecord(input: {
  projectId: string;
  objectDigest: ObjectDigest;
  input: PutObjectInput;
  keyId: string;
  algorithm: NonNullable<PutObjectInput["encryptionAlgorithm"]>;
  nonce: Uint8Array;
  createdAt: string;
}): ArtifactStorageRecord {
  const record: ArtifactStorageRecord = {
    schemaVersion: 1,
    projectId: input.projectId,
    objectDigest: input.objectDigest,
    mediaType: input.input.mediaType,
    plaintextByteSize: input.input.bytes.byteLength,
    classification: input.input.classification,
    encryptionAlgorithm: input.algorithm,
    encryptionKeyId: input.keyId,
    encryptionNonceBase64: nonceToBase64(input.nonce),
    createdAt: input.createdAt,
  };
  if (input.input.schemaName !== undefined) {
    return { ...record, schemaName: input.input.schemaName };
  }
  return record;
}

function assertProjectId(value: string): string {
  if (!PROJECT_ID.Check(value)) {
    throw new CasError("INVALID_PROJECT_ID", "invalid project id");
  }
  return value;
}

function assertObjectDigest(value: string): ObjectDigest {
  if (!OBJECT_DIGEST.Check(value)) {
    throw new CasError("INVALID_DIGEST", "object digest must be sha256 lowercase hex");
  }
  return value as ObjectDigest;
}

function digestsMatch(left: ObjectDigest, right: ObjectDigest): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  return timingSafeEqual(a, b);
}

async function exclusiveInstall(incoming: string, dest: string): Promise<"installed" | "exists"> {
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    await link(incoming, dest);
    await unlink(incoming);
    await fsyncDir(path.dirname(dest));
    return "installed";
  } catch (error) {
    if ((isNodeError(error) && error.code === "EEXIST") || (await pathIsFile(dest))) {
      return "exists";
    }
    try {
      await copyFile(incoming, dest, constants.COPYFILE_EXCL);
      await fsyncFile(dest);
      await unlink(incoming);
      await fsyncDir(path.dirname(dest));
      return "installed";
    } catch (copyError) {
      if ((isNodeError(copyError) && copyError.code === "EEXIST") || (await pathIsFile(dest))) {
        return "exists";
      }
      throw copyError;
    }
  }
}

async function pathIsFile(filePath: string): Promise<boolean> {
  try {
    const info = await lstat(filePath);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function unlinkQuiet(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function fsyncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDir(dirPath: string): Promise<void> {
  try {
    const handle = await open(dirPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      isNodeError(error) &&
      (error.code === "EINVAL" ||
        error.code === "EBADF" ||
        error.code === "EPERM" ||
        error.code === "ENOTSUP")
    ) {
      return;
    }
    if (process.platform === "win32") {
      return;
    }
    throw error;
  }
}
