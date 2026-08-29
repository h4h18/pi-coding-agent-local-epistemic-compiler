import { gcm } from "@noble/ciphers/aes.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import {
  ArtifactStorageRecordSchema,
  canonicalizeRfc8785,
  objectDigestFromBytes,
  taggedHash,
} from "@pi-hec/contracts";
import type {
  ArtifactStorageRecord,
  DomainDigest,
  JsonValue,
  ObjectDigest,
} from "@pi-hec/contracts";
import { Compile } from "typebox/compile";
import { CasError } from "./blob-store.js";
import type { EncryptionAlgorithm } from "./blob-store.js";

const STORAGE_RECORD = Compile(ArtifactStorageRecordSchema);
const BLOB_MAGIC = Buffer.from("HEC1", "ascii");
const ALG_AES_GCM = 1;
const ALG_XCHACHA = 2;
const AES_GCM_NONCE_BYTES = 12;
const XCHACHA_NONCE_BYTES = 24;
const TAG_BYTES = 16;

export type AadFields = {
  projectId: string;
  objectDigest: ObjectDigest;
  mediaType: string;
  byteSize: number;
  schemaName?: string;
};

export type ParsedBlob = {
  algorithm: EncryptionAlgorithm;
  keyId: string;
  nonce: Uint8Array;
  aad: Uint8Array;
  ciphertext: Uint8Array;
};

export function encodeAad(fields: AadFields): Uint8Array {
  const payload: { [key: string]: JsonValue } = {
    projectId: fields.projectId,
    objectDigest: fields.objectDigest,
    mediaType: fields.mediaType,
    byteSize: fields.byteSize,
  };
  if (fields.schemaName !== undefined) {
    payload.schemaName = fields.schemaName;
  }
  return Buffer.from(canonicalizeRfc8785(payload), "utf8");
}

export function nonceLength(algorithm: EncryptionAlgorithm): number {
  switch (algorithm) {
    case "AES-256-GCM":
      return AES_GCM_NONCE_BYTES;
    case "XCHACHA20-POLY1305":
      return XCHACHA_NONCE_BYTES;
    default: {
      const exhaustive: never = algorithm;
      throw new CasError("INVALID_KEY", `unsupported algorithm ${String(exhaustive)}`);
    }
  }
}

export function randomNonce(algorithm: EncryptionAlgorithm): Uint8Array {
  return randomBytes(nonceLength(algorithm));
}

export function encryptPlaintext(
  algorithm: EncryptionAlgorithm,
  dek: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  assertDek(dek);
  switch (algorithm) {
    case "AES-256-GCM":
      return gcm(dek, nonce, aad).encrypt(plaintext);
    case "XCHACHA20-POLY1305":
      return xchacha20poly1305(dek, nonce, aad).encrypt(plaintext);
    default: {
      const exhaustive: never = algorithm;
      throw new CasError("INVALID_KEY", `unsupported algorithm ${String(exhaustive)}`);
    }
  }
}

export function decryptCiphertext(
  algorithm: EncryptionAlgorithm,
  dek: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  assertDek(dek);
  if (ciphertext.byteLength < TAG_BYTES) {
    throw new CasError("TRUNCATED", "ciphertext shorter than AEAD tag");
  }
  try {
    switch (algorithm) {
      case "AES-256-GCM":
        return gcm(dek, nonce, aad).decrypt(ciphertext);
      case "XCHACHA20-POLY1305":
        return xchacha20poly1305(dek, nonce, aad).decrypt(ciphertext);
      default: {
        const exhaustive: never = algorithm;
        throw new CasError("INVALID_KEY", `unsupported algorithm ${String(exhaustive)}`);
      }
    }
  } catch (error) {
    if (error instanceof CasError) {
      throw error;
    }
    throw new CasError("CORRUPT", "AEAD tag verification failed");
  }
}

export function encodeBlob(input: {
  algorithm: EncryptionAlgorithm;
  keyId: string;
  nonce: Uint8Array;
  aad: Uint8Array;
  ciphertext: Uint8Array;
}): Uint8Array {
  const keyIdBytes = Buffer.from(input.keyId, "utf8");
  if (keyIdBytes.byteLength > 0xffff) {
    throw new CasError("INVALID_KEY", "encryptionKeyId exceeds 65535 bytes");
  }
  const header = Buffer.alloc(BLOB_MAGIC.byteLength + 1 + 2 + keyIdBytes.byteLength + input.nonce.byteLength + 4);
  let offset = 0;
  header.set(BLOB_MAGIC, offset);
  offset += BLOB_MAGIC.byteLength;
  header[offset] = algorithmByte(input.algorithm);
  offset += 1;
  header.writeUInt16BE(keyIdBytes.byteLength, offset);
  offset += 2;
  header.set(keyIdBytes, offset);
  offset += keyIdBytes.byteLength;
  header.set(input.nonce, offset);
  offset += input.nonce.byteLength;
  header.writeUInt32BE(input.aad.byteLength, offset);
  return Buffer.concat([header, input.aad, input.ciphertext]);
}

export function parseBlob(bytes: Uint8Array): ParsedBlob {
  let offset = 0;
  if (bytes.byteLength < BLOB_MAGIC.byteLength + 1 + 2 + 4 + TAG_BYTES) {
    throw new CasError("TRUNCATED", "blob shorter than minimum envelope");
  }
  if (!bufferEquals(bytes.subarray(0, BLOB_MAGIC.byteLength), BLOB_MAGIC)) {
    throw new CasError("CORRUPT", "blob magic mismatch");
  }
  offset = BLOB_MAGIC.byteLength;
  const algorithm = algorithmFromByte(bytes[offset]);
  offset += 1;
  if (algorithm === undefined) {
    throw new CasError("CORRUPT", "unknown blob encryption algorithm");
  }
  const keyIdLen = readUInt16BE(bytes, offset);
  offset += 2;
  const keyIdEnd = offset + keyIdLen;
  if (keyIdEnd > bytes.byteLength) {
    throw new CasError("TRUNCATED", "blob truncated in key id");
  }
  const keyId = Buffer.from(bytes.subarray(offset, keyIdEnd)).toString("utf8");
  offset = keyIdEnd;
  const nonceLen = nonceLength(algorithm);
  const nonceEnd = offset + nonceLen;
  if (nonceEnd > bytes.byteLength) {
    throw new CasError("TRUNCATED", "blob truncated in nonce");
  }
  const nonce = bytes.slice(offset, nonceEnd);
  offset = nonceEnd;
  if (offset + 4 > bytes.byteLength) {
    throw new CasError("TRUNCATED", "blob truncated in AAD length");
  }
  const aadLen = readUInt32BE(bytes, offset);
  offset += 4;
  const aadEnd = offset + aadLen;
  if (aadEnd > bytes.byteLength) {
    throw new CasError("TRUNCATED", "blob truncated in AAD");
  }
  const aad = bytes.slice(offset, aadEnd);
  const ciphertext = bytes.slice(aadEnd);
  if (ciphertext.byteLength < TAG_BYTES) {
    throw new CasError("TRUNCATED", "blob truncated in ciphertext");
  }
  return { algorithm, keyId, nonce, aad, ciphertext };
}

export function digestPlaintext(bytes: Uint8Array): ObjectDigest {
  return objectDigestFromBytes(bytes);
}

export function storageRecordJson(record: ArtifactStorageRecord): JsonValue {
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

export function storageRecordDigest(
  record: ArtifactStorageRecord,
): DomainDigest<"storage-record"> {
  if (!STORAGE_RECORD.Check(record)) {
    throw new CasError("CORRUPT", "ArtifactStorageRecord failed schema validation");
  }
  return taggedHash("storage-record", 1, storageRecordJson(record));
}

export function nonceToBase64(nonce: Uint8Array): string {
  return Buffer.from(nonce).toString("base64");
}

export function absorbDummyAead(dek: Uint8Array): void {
  if (dek.byteLength !== 32) {
    return;
  }
  const nonce = new Uint8Array(AES_GCM_NONCE_BYTES);
  const aad = new Uint8Array(0);
  const plain = new Uint8Array(32);
  gcm(dek, nonce, aad).encrypt(plain);
}

function assertDek(dek: Uint8Array): void {
  if (dek.byteLength !== 32) {
    throw new CasError("INVALID_KEY", "project DEK must be 32 bytes");
  }
}

function algorithmByte(algorithm: EncryptionAlgorithm): number {
  switch (algorithm) {
    case "AES-256-GCM":
      return ALG_AES_GCM;
    case "XCHACHA20-POLY1305":
      return ALG_XCHACHA;
    default: {
      const exhaustive: never = algorithm;
      throw new CasError("INVALID_KEY", `unsupported algorithm ${String(exhaustive)}`);
    }
  }
}

function algorithmFromByte(value: number | undefined): EncryptionAlgorithm | undefined {
  if (value === ALG_AES_GCM) {
    return "AES-256-GCM";
  }
  if (value === ALG_XCHACHA) {
    return "XCHACHA20-POLY1305";
  }
  return undefined;
}

function readUInt16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) * 256 + (bytes[offset + 1] ?? 0);
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 0x1000000 +
    (bytes[offset + 1] ?? 0) * 0x10000 +
    (bytes[offset + 2] ?? 0) * 0x100 +
    (bytes[offset + 3] ?? 0)
  );
}

function bufferEquals(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}
