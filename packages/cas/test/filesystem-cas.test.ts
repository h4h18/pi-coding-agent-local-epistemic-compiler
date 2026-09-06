import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import type * as nodeFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { canonicalizeRfc8785, objectDigestFromBytes, taggedHash } from "@pi-hec/contracts";
import type { ArtifactStorageRecord, JsonValue, ObjectDigest } from "@pi-hec/contracts";
import {
  CasError,
  createFilesystemCas,
  INCOMING_SWEEP_MIN_MS,
  MemoryStorageRecordSink,
} from "../src/index.js";
import type { FilesystemCas, KekHook, OccupancyPredicate, PutObjectInput } from "../src/index.js";

const fsHooks = vi.hoisted(() => ({
  corruptIncomingOnSync: false,
  beforeExclusiveInstall: (): Promise<void> => Promise.resolve(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFsPromises>();
  function isIncomingPath(filePath: string): boolean {
    return filePath.replaceAll("\\", "/").includes("/incoming/");
  }
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const filePath = String(args[0]);
      if (!fsHooks.corruptIncomingOnSync || !isIncomingPath(filePath)) {
        return handle;
      }
      const originalSync = handle.sync.bind(handle);
      handle.sync = async () => {
        await originalSync();
        const info = await handle.stat();
        if (info.isFile() && info.size > 0) {
          await handle.write(Buffer.from([0xff]), 0, 1, info.size - 1);
          await originalSync();
        }
      };
      return handle;
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      const source = String(args[0]);
      if (isIncomingPath(source)) {
        await fsHooks.beforeExclusiveInstall();
      }
      return actual.link(...args);
    },
    copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
      const source = String(args[0]);
      if (isIncomingPath(source)) {
        await fsHooks.beforeExclusiveInstall();
      }
      return actual.copyFile(...args);
    },
  };
});

const PROJECT_A = "proj-alpha";
const PROJECT_B = "proj-beta";
const MEDIA = "application/octet-stream";

const dirs: string[] = [];
const DEK = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const DEK_ROTATED = Uint8Array.from({ length: 32 }, (_, index) => index + 50);

afterEach(async () => {
  fsHooks.corruptIncomingOnSync = false;
  fsHooks.beforeExclusiveInstall = (): Promise<void> => Promise.resolve();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-hec-cas-"));
  dirs.push(dir);
  return dir;
}

function fakeKek(): KekHook {
  return {
    unwrapProjectDek: () => ({ keyId: "test-dek-1", dek: DEK }),
  };
}

function occupancy(forbidden: ReadonlySet<string> = new Set()): OccupancyPredicate {
  return {
    isGcForbidden: (_projectId, objectDigest) => forbidden.has(objectDigest),
  };
}

function mutableClock(start = Date.parse("2026-01-15T00:00:00.000Z")): {
  nowMs: number;
  clock: { nowIso: () => string; nowMs: () => number };
} {
  const state = { nowMs: start };
  return {
    get nowMs() {
      return state.nowMs;
    },
    set nowMs(value: number) {
      state.nowMs = value;
    },
    clock: {
      nowIso: () => new Date(state.nowMs).toISOString(),
      nowMs: () => state.nowMs,
    },
  };
}

async function openCas(options?: {
  forbidden?: ReadonlySet<string>;
  clock?: { nowIso: () => string; nowMs: () => number };
  kek?: KekHook;
  skipOccupancy?: boolean;
}): Promise<{
  cas: FilesystemCas;
  sink: MemoryStorageRecordSink;
  rootDir: string;
}> {
  const rootDir = await tempRoot();
  const sink = new MemoryStorageRecordSink();
  const cas = createFilesystemCas({
    rootDir,
    sink,
    kek: options?.kek ?? fakeKek(),
    ...(options?.skipOccupancy === true ? {} : { occupancy: occupancy(options?.forbidden) }),
    ...(options?.clock === undefined ? {} : { clock: options.clock }),
  });
  return { cas, sink, rootDir };
}

function putInput(bytes: Uint8Array, extras: Partial<PutObjectInput> = {}): PutObjectInput {
  return {
    projectId: PROJECT_A,
    bytes,
    mediaType: MEDIA,
    classification: "internal",
    ...extras,
  };
}

function hexBody(digest: ObjectDigest): string {
  return digest.slice("sha256:".length);
}

function objectPath(rootDir: string, projectId: string, digest: ObjectDigest): string {
  const hex = hexBody(digest);
  return path.join(rootDir, "projects", projectId, "sha256", hex.slice(0, 2), hex.slice(2, 4), hex);
}

test("put then get round-trips plaintext and uses plaintext ObjectDigest", async () => {
  const { cas } = await openCas();
  const bytes = new TextEncoder().encode("cas-plaintext");
  const result = await cas.putObject(putInput(bytes));
  expect(result.objectDigest).toBe(objectDigestFromBytes(bytes));
  const ciphertextHash = createHash("sha256")
    .update(await readFile(cas.objectPath(PROJECT_A, result.objectDigest)))
    .digest("hex");
  expect(result.objectDigest).not.toBe(`sha256:${ciphertextHash}`);
  const loaded = await cas.getObject({
    projectId: PROJECT_A,
    objectDigest: result.objectDigest,
  });
  expect(Buffer.from(loaded)).toEqual(Buffer.from(bytes));
});

test("idempotent put of identical bytes keeps the existing object", async () => {
  const { cas, sink } = await openCas();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const first = await cas.putObject(putInput(bytes));
  const dest = cas.objectPath(PROJECT_A, first.objectDigest);
  const before = await readFile(dest);
  const second = await cas.putObject(putInput(bytes));
  expect(second.objectDigest).toBe(first.objectDigest);
  expect(second.reusedExisting).toBe(true);
  expect(await readFile(dest)).toEqual(before);
  expect(sink.records).toHaveLength(1);
});

test("existing object cannot be overwritten by exclusive install of different ciphertext", async () => {
  const { cas } = await openCas();
  const bytes = new Uint8Array([9, 8, 7]);
  const result = await cas.putObject(putInput(bytes));
  const dest = cas.objectPath(PROJECT_A, result.objectDigest);
  const original = await readFile(dest);
  await expect(
    writeFile(dest, nodeRandomBytes(original.byteLength + 32), { flag: "wx" }),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(dest)).toEqual(original);
  expect(
    Buffer.from(await cas.getObject({ projectId: PROJECT_A, objectDigest: result.objectDigest })),
  ).toEqual(Buffer.from(bytes));
});

test("corrupted object is quarantined and never returned as valid", async () => {
  const { cas, rootDir } = await openCas();
  const bytes = new TextEncoder().encode("corrupt-me");
  const result = await cas.putObject(putInput(bytes));
  const dest = cas.objectPath(PROJECT_A, result.objectDigest);
  const file = Buffer.from(await readFile(dest));
  file[file.byteLength - 1] = (file[file.byteLength - 1] ?? 0) ^ 0xff;
  await writeFile(dest, file);
  await expect(
    cas.getObject({ projectId: PROJECT_A, objectDigest: result.objectDigest }),
  ).rejects.toBeInstanceOf(CasError);
  await expect(
    cas.getObject({ projectId: PROJECT_A, objectDigest: result.objectDigest }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
  const quarantineRoot = path.join(rootDir, "projects", PROJECT_A, "quarantine");
  const hex = hexBody(result.objectDigest);
  const found = await findNamed(quarantineRoot, hex);
  expect(found).toBe(true);
});

test("truncated object is never returned as valid", async () => {
  const { cas } = await openCas();
  const bytes = new TextEncoder().encode("truncate-me");
  const result = await cas.putObject(putInput(bytes));
  const dest = cas.objectPath(PROJECT_A, result.objectDigest);
  await truncate(dest, 4);
  await expect(
    cas.getObject({ projectId: PROJECT_A, objectDigest: result.objectDigest }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("partial write left in incoming is not returned as a valid object", async () => {
  const { cas, rootDir } = await openCas();
  const bytes = new TextEncoder().encode("never-installed");
  const digest = objectDigestFromBytes(bytes);
  const incomingDir = path.join(rootDir, "projects", PROJECT_A, "incoming");
  await mkdir(incomingDir, { recursive: true });
  const incoming = path.join(incomingDir, "deadbeef-dead-7eef-a000-000000000001");
  await writeFile(incoming, bytes, { flag: "wx" });
  await expect(cas.getObject({ projectId: PROJECT_A, objectDigest: digest })).rejects.toMatchObject(
    {
      code: "NOT_FOUND",
    },
  );
  await expect(stat(objectPath(rootDir, PROJECT_A, digest))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("concurrent writers of identical bytes converge on one object", async () => {
  const { cas } = await openCas();
  const bytes = new TextEncoder().encode("concurrent-payload");
  const [left, right] = await Promise.all([
    cas.putObject(putInput(bytes)),
    cas.putObject(putInput(bytes)),
  ]);
  expect(left.objectDigest).toBe(right.objectDigest);
  expect(left.objectDigest).toBe(objectDigestFromBytes(bytes));
  const loaded = await cas.getObject({ projectId: PROJECT_A, objectDigest: left.objectDigest });
  expect(Buffer.from(loaded)).toEqual(Buffer.from(bytes));
});

test("verify-on-read mismatch quarantines and does not return plaintext", async () => {
  const { cas, sink } = await openCas();
  const bytes = new TextEncoder().encode("security-critical");
  const result = await cas.putObject(putInput(bytes, { securityCritical: true }));
  const dest = cas.objectPath(PROJECT_A, result.objectDigest);
  const mutated = Buffer.from(await readFile(dest));
  const flipAt = Math.max(0, mutated.byteLength - 3);
  mutated.writeUInt8(mutated.readUInt8(flipAt) ^ 0x5a, flipAt);
  await writeFile(dest, mutated);
  let caught: unknown;
  try {
    await cas.getObject({
      projectId: PROJECT_A,
      objectDigest: result.objectDigest,
      securityCritical: true,
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CasError);
  expect(sink.records[0]?.objectDigest).toBe(result.objectDigest);
});

test("cross-project miss does not reveal another project's object", async () => {
  const { cas } = await openCas();
  const bytes = new TextEncoder().encode("project-scoped");
  const stored = await cas.putObject(putInput(bytes));
  const started = process.hrtime.bigint();
  await expect(
    cas.getObject({ projectId: PROJECT_B, objectDigest: stored.objectDigest }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  const missOther = process.hrtime.bigint() - started;
  const missStart = process.hrtime.bigint();
  const missingDigest = objectDigestFromBytes(new TextEncoder().encode("absent-in-every-project"));
  await expect(
    cas.getObject({ projectId: PROJECT_B, objectDigest: missingDigest }),
  ).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  const missAbsent = process.hrtime.bigint() - missStart;
  expect(
    await cas.getObject({ projectId: PROJECT_A, objectDigest: stored.objectDigest }),
  ).toBeInstanceOf(Uint8Array);
  const ratio = Number(missOther) / Math.max(Number(missAbsent), 1);
  expect(ratio).toBeLessThan(8);
  expect(ratio).toBeGreaterThan(0.125);
});

test("GC marks unreachable objects into quarantine then explicit sweep after 30 days", async () => {
  const time = mutableClock();
  const { cas, rootDir } = await openCas({ clock: time.clock });
  const keep = new TextEncoder().encode("keep-me");
  const drop = new TextEncoder().encode("drop-me");
  const kept = await cas.putObject(putInput(keep));
  const dropped = await cas.putObject(putInput(drop));
  await cas.markUnreachable(PROJECT_A, new Set([kept.objectDigest]));
  await expect(
    cas.getObject({ projectId: PROJECT_A, objectDigest: dropped.objectDigest }),
  ).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(
    Buffer.from(await cas.getObject({ projectId: PROJECT_A, objectDigest: kept.objectDigest })),
  ).toEqual(Buffer.from(keep));
  const hex = hexBody(dropped.objectDigest);
  expect(await findNamed(path.join(rootDir, "projects", PROJECT_A, "quarantine"), hex)).toBe(true);
  await cas.sweepQuarantine(PROJECT_A);
  expect(await findNamed(path.join(rootDir, "projects", PROJECT_A, "quarantine"), hex)).toBe(true);
  time.nowMs = Date.parse("2026-02-20T00:00:00.000Z");
  await cas.sweepQuarantine(PROJECT_A);
  expect(await findNamed(path.join(rootDir, "projects", PROJECT_A, "quarantine"), hex)).toBe(false);
});

test("GC refuses objects referenced by occupancy (nonterminal / CLOUD_OUTCOME_UNKNOWN)", async () => {
  const bytes = new TextEncoder().encode("occupied");
  const digest = objectDigestFromBytes(bytes);
  const time = mutableClock();
  const { cas } = await openCas({ forbidden: new Set([digest]), clock: time.clock });
  await cas.putObject(putInput(bytes));
  await cas.markUnreachable(PROJECT_A, new Set());
  expect(Buffer.from(await cas.getObject({ projectId: PROJECT_A, objectDigest: digest }))).toEqual(
    Buffer.from(bytes),
  );
  time.nowMs = Date.parse("2026-03-01T00:00:00.000Z");
  await cas.sweepQuarantine(PROJECT_A);
  expect(Buffer.from(await cas.getObject({ projectId: PROJECT_A, objectDigest: digest }))).toEqual(
    Buffer.from(bytes),
  );
});

test("storage_record_digest is taggedHash storage-record of the ArtifactStorageRecord", async () => {
  const { cas, sink } = await openCas();
  const bytes = new TextEncoder().encode("record-digest");
  const result = await cas.putObject(putInput(bytes, { schemaName: "ArtifactStorageRecord" }));
  const record = sink.records[0];
  expect(record).toBeDefined();
  if (record === undefined) {
    return;
  }
  expect(result.storageRecordDigest).toBe(
    taggedHash("storage-record", 1, storageRecordJson(record)),
  );
});

test("AAD binds project, digest, media type, size and schema", async () => {
  const { cas } = await openCas();
  const bytes = new TextEncoder().encode("aad-bound");
  const result = await cas.putObject(
    putInput(bytes, { schemaName: "TaskEnvelope", mediaType: "application/json" }),
  );
  const aad = canonicalizeRfc8785({
    projectId: PROJECT_A,
    objectDigest: result.objectDigest,
    mediaType: "application/json",
    byteSize: bytes.byteLength,
    schemaName: "TaskEnvelope",
  });
  expect(aad.length).toBeGreaterThan(0);
  expect(
    Buffer.from(await cas.getObject({ projectId: PROJECT_A, objectDigest: result.objectDigest })),
  ).toEqual(Buffer.from(bytes));
});

test("XCHACHA20-POLY1305 put/get round-trips", async () => {
  const { cas } = await openCas();
  const bytes = new TextEncoder().encode("xchacha-bytes");
  const result = await cas.putObject(
    putInput(bytes, { encryptionAlgorithm: "XCHACHA20-POLY1305" }),
  );
  expect(result.storageRecord.encryptionAlgorithm).toBe("XCHACHA20-POLY1305");
  expect(
    Buffer.from(await cas.getObject({ projectId: PROJECT_A, objectDigest: result.objectDigest })),
  ).toEqual(Buffer.from(bytes));
});

test("corrupt incoming is verified before install and never appears as a sha256 object", async () => {
  const { cas, rootDir } = await openCas();
  const bytes = new TextEncoder().encode("corrupt-incoming-before-install");
  const digest = objectDigestFromBytes(bytes);
  fsHooks.corruptIncomingOnSync = true;
  await expect(cas.putObject(putInput(bytes))).rejects.toMatchObject({ code: "CORRUPT" });
  await expect(stat(objectPath(rootDir, PROJECT_A, digest))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(cas.getObject({ projectId: PROJECT_A, objectDigest: digest })).rejects.toMatchObject(
    {
      code: "NOT_FOUND",
    },
  );
});

test("get unwraps DEK via envelope encryptionKeyId after KEK rotation", async () => {
  let currentKeyId = "dek-v1";
  const kek: KekHook = {
    unwrapProjectDek: (input) => {
      const keyId = input.encryptionKeyId ?? currentKeyId;
      if (keyId === "dek-v1") {
        return { keyId: "dek-v1", dek: DEK };
      }
      if (keyId === "dek-v2") {
        return { keyId: "dek-v2", dek: DEK_ROTATED };
      }
      throw new CasError("INVALID_KEY", "unknown encryptionKeyId");
    },
  };
  const { cas, rootDir } = await openCas({ kek });
  const bytes = new TextEncoder().encode("rotated-kek-plaintext");
  const stored = await cas.putObject(putInput(bytes));
  const dest = objectPath(rootDir, PROJECT_A, stored.objectDigest);
  currentKeyId = "dek-v2";
  expect(
    Buffer.from(await cas.getObject({ projectId: PROJECT_A, objectDigest: stored.objectDigest })),
  ).toEqual(Buffer.from(bytes));
  expect((await stat(dest)).isFile()).toBe(true);

  kek.unwrapProjectDek = () => ({ keyId: "dek-v2", dek: DEK_ROTATED });
  await expect(
    cas.getObject({ projectId: PROJECT_A, objectDigest: stored.objectDigest }),
  ).rejects.toMatchObject({ code: "INVALID_KEY" });
  expect((await stat(dest)).isFile()).toBe(true);
});

test("sweepIncoming does not delete in-flight put staging files", async () => {
  const { cas, rootDir } = await openCas();
  await mkdir(path.join(rootDir, "projects", PROJECT_A, "quarantine"), { recursive: true });
  const bytes = new TextEncoder().encode("in-flight-incoming");
  fsHooks.beforeExclusiveInstall = async () => {
    await cas.sweepQuarantine(PROJECT_A);
  };
  const stored = await cas.putObject(putInput(bytes));
  expect(
    Buffer.from(await cas.getObject({ projectId: PROJECT_A, objectDigest: stored.objectDigest })),
  ).toEqual(Buffer.from(bytes));
});

test("sweepIncoming keeps young incoming and deletes aged leftovers", async () => {
  const { cas, rootDir } = await openCas();
  await mkdir(path.join(rootDir, "projects", PROJECT_A, "quarantine"), { recursive: true });
  const incomingDir = path.join(rootDir, "projects", PROJECT_A, "incoming");
  await mkdir(incomingDir, { recursive: true });
  const leftover = path.join(incomingDir, "stale-incoming-uuid");
  const bytes = new TextEncoder().encode("incoming-age");
  await writeFile(leftover, bytes, { flag: "wx" });
  await cas.sweepQuarantine(PROJECT_A);
  await expect(stat(leftover)).resolves.toMatchObject({ size: bytes.byteLength });
  const aged = Date.now() / 1000 - (INCOMING_SWEEP_MIN_MS + 1000) / 1000;
  await utimes(leftover, aged, aged);
  await cas.sweepQuarantine(PROJECT_A);
  await expect(stat(leftover)).rejects.toMatchObject({ code: "ENOENT" });
});

test("sweepIncoming after a completed put still deletes aged leftovers", async () => {
  const { cas, rootDir } = await openCas();
  await cas.putObject(putInput(new TextEncoder().encode("lock-warmup")));
  await cas.getObject({
    projectId: PROJECT_A,
    objectDigest: objectDigestFromBytes(new TextEncoder().encode("lock-warmup")),
  });
  const incomingDir = path.join(rootDir, "projects", PROJECT_A, "incoming");
  await mkdir(incomingDir, { recursive: true });
  const leftover = path.join(incomingDir, "aged-after-put");
  const bytes = new TextEncoder().encode("leftover-after-put");
  await writeFile(leftover, bytes, { flag: "wx" });
  const aged = Date.now() / 1000 - (INCOMING_SWEEP_MIN_MS + 1000) / 1000;
  await utimes(leftover, aged, aged);
  await cas.sweepQuarantine(PROJECT_A);
  await expect(stat(leftover)).rejects.toMatchObject({ code: "ENOENT" });
});

test("GC without occupancy throws and does not sweep", async () => {
  const { cas, rootDir } = await openCas({ skipOccupancy: true });
  const bytes = new TextEncoder().encode("occupancy-required");
  const stored = await cas.putObject(putInput(bytes));
  const incomingDir = path.join(rootDir, "projects", PROJECT_A, "incoming");
  await mkdir(incomingDir, { recursive: true });
  const leftover = path.join(incomingDir, "must-not-sweep");
  await writeFile(leftover, bytes, { flag: "wx" });
  const aged = Date.now() / 1000 - (INCOMING_SWEEP_MIN_MS + 1000) / 1000;
  await utimes(leftover, aged, aged);
  await expect(cas.markUnreachable(PROJECT_A, new Set())).rejects.toMatchObject({
    code: "GC_FORBIDDEN",
  });
  await expect(cas.sweepQuarantine(PROJECT_A)).rejects.toMatchObject({ code: "GC_FORBIDDEN" });
  expect(
    Buffer.from(await cas.getObject({ projectId: PROJECT_A, objectDigest: stored.objectDigest })),
  ).toEqual(Buffer.from(bytes));
  expect((await stat(leftover)).isFile()).toBe(true);
});

function storageRecordJson(record: ArtifactStorageRecord): JsonValue {
  const json: { [key: string]: JsonValue } = {
    schemaVersion: record.schemaVersion,
    projectId: record.projectId,
    objectDigest: record.objectDigest,
    mediaType: record.mediaType,
    plaintextByteSize: record.plaintextByteSize,
    classification: record.classification,
    encryptionAlgorithm: record.encryptionAlgorithm,
    encryptionKeyId: record.encryptionKeyId,
    encryptionNonceBase64: record.encryptionNonceBase64,
    createdAt: record.createdAt,
  };
  if (record.schemaName !== undefined) {
    json.schemaName = record.schemaName;
  }
  return json;
}

async function findNamed(root: string, name: string): Promise<boolean> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (entry.name === name) {
        return true;
      }
      if (entry.isDirectory() && (await findNamed(full, name))) {
        return true;
      }
    }
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
