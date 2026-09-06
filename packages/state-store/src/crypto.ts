import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { canonicalizeRfc8785 } from "@pi-hec/domain";

export const DB_RESPONSE_KEY_ID_PREFIX = "db-response:";
export const AES_GCM_NONCE_BYTES = 12;
export const LEASE_TOKEN_BYTES = 32;

export type Argon2idParameters = {
  readonly encodingVersion: 1;
  readonly argon2Version: 19;
  readonly memoryKiB: number;
  readonly passes: number;
  readonly parallelism: number;
  readonly hashLength: number;
  readonly saltLength: number;
};

export const ARGON2ID_PRODUCTION_PARAMETERS: Argon2idParameters = {
  encodingVersion: 1,
  argon2Version: 19,
  memoryKiB: 65536,
  passes: 3,
  parallelism: 1,
  hashLength: 32,
  saltLength: 16,
};

export const ARGON2ID_TEST_PARAMETERS: Argon2idParameters = {
  encodingVersion: 1,
  argon2Version: 19,
  memoryKiB: 8,
  passes: 1,
  parallelism: 1,
  hashLength: 32,
  saltLength: 16,
};

export function responseKeyIdFor(dbResponseKey: Uint8Array): string {
  const digest = createHmac("sha256", Buffer.from("pi-hec.db-response-key-id"))
    .update(dbResponseKey)
    .digest("hex")
    .slice(0, 32);
  return `${DB_RESPONSE_KEY_ID_PREFIX}${digest}`;
}

export function hashLeaseToken(hostLeaseKey: Uint8Array, token: Uint8Array): Buffer {
  return createHmac("sha256", hostLeaseKey).update(token).digest();
}

export function leaseTokenHashHex(hostLeaseKey: Uint8Array, token: Uint8Array): string {
  return hashLeaseToken(hostLeaseKey, token).toString("hex");
}

export function generateLeaseToken(): Buffer {
  return randomBytes(LEASE_TOKEN_BYTES);
}

export function hmacEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    const dummy = Buffer.alloc(right.byteLength);
    timingSafeEqual(dummy, Buffer.from(right));
    return false;
  }
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function verifyLeaseToken(
  hostLeaseKey: Uint8Array,
  token: Uint8Array,
  storedHex: string,
): boolean {
  const expected = hashLeaseToken(hostLeaseKey, token);
  const stored = Buffer.from(storedHex, "hex");
  return hmacEqual(stored, expected);
}

export type EncryptedResponse = {
  keyId: string;
  nonce: Buffer;
  headersCiphertext: Buffer;
  bodyCiphertext: Buffer;
};

export type ResponseAadFields = {
  principalId: string;
  scopeKey: string;
  operationId: string;
  semanticRequestDigest: string;
};

export function responseAad(fields: ResponseAadFields): Buffer {
  return Buffer.from(
    canonicalizeRfc8785({
      operationId: fields.operationId,
      principalId: fields.principalId,
      scopeKey: fields.scopeKey,
      semanticRequestDigest: fields.semanticRequestDigest,
    }),
    "utf8",
  );
}

export function encryptApiResponsePayload(
  dbResponseKey: Uint8Array,
  keyId: string,
  aad: Uint8Array,
  headers: Uint8Array,
  body: Uint8Array,
): EncryptedResponse {
  const nonce = randomBytes(AES_GCM_NONCE_BYTES);
  const packed = packResponsePlaintext(headers, body);
  const cipher = createCipheriv("aes-256-gcm", dbResponseKey, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(packed), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { keyId, nonce, headersCiphertext: tag, bodyCiphertext: ciphertext };
}

export function decryptApiResponsePayload(
  dbResponseKey: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array,
  headersCiphertext: Uint8Array,
  bodyCiphertext: Uint8Array,
): { headers: Buffer; body: Buffer } {
  const decipher = createDecipheriv("aes-256-gcm", dbResponseKey, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(headersCiphertext);
  const packed = Buffer.concat([decipher.update(bodyCiphertext), decipher.final()]);
  return unpackResponsePlaintext(packed);
}

function packResponsePlaintext(headers: Uint8Array, body: Uint8Array): Buffer {
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(headers.byteLength);
  return Buffer.concat([headerLength, Buffer.from(headers), Buffer.from(body)]);
}

function unpackResponsePlaintext(packed: Buffer): { headers: Buffer; body: Buffer } {
  if (packed.byteLength < 4) {
    throw new Error("truncated encrypted response");
  }
  const headerLength = packed.readUInt32BE(0);
  if (packed.byteLength < 4 + headerLength) {
    throw new Error("truncated encrypted response headers");
  }
  return {
    headers: packed.subarray(4, 4 + headerLength),
    body: packed.subarray(4 + headerLength),
  };
}

export async function hashSecretArgon2id(
  secret: Uint8Array,
  parameters: Argon2idParameters,
  salt: Uint8Array = randomBytes(parameters.saltLength),
): Promise<string> {
  const derived = await deriveArgon2id(secret, salt, parameters);
  return [
    `v${String(parameters.encodingVersion)}`,
    "argon2id",
    `ver=${String(parameters.argon2Version)}`,
    `m=${String(parameters.memoryKiB)}`,
    `t=${String(parameters.passes)}`,
    `p=${String(parameters.parallelism)}`,
    Buffer.from(salt).toString("base64url"),
    Buffer.from(derived).toString("base64url"),
  ].join("$");
}

export async function verifySecretArgon2id(secret: Uint8Array, stored: string): Promise<boolean> {
  const parsed = parseArgon2idVerifier(stored);
  const derived = await deriveArgon2id(secret, parsed.salt, parsed.parameters);
  return hmacEqual(derived, parsed.hash);
}

type ParsedVerifier = {
  parameters: Argon2idParameters;
  salt: Buffer;
  hash: Buffer;
};

export function parseArgon2idVerifier(stored: string): ParsedVerifier {
  const parts = stored.split("$");
  if (parts.length !== 8 || parts[0] !== "v1" || parts[1] !== "argon2id") {
    throw new Error("invalid argon2id verifier");
  }
  const ver = parts[2];
  const memory = parts[3];
  const passes = parts[4];
  const parallelism = parts[5];
  const saltPart = parts[6];
  const hashPart = parts[7];
  if (
    ver === undefined ||
    memory === undefined ||
    passes === undefined ||
    parallelism === undefined ||
    saltPart === undefined ||
    hashPart === undefined ||
    !ver.startsWith("ver=") ||
    !memory.startsWith("m=") ||
    !passes.startsWith("t=") ||
    !parallelism.startsWith("p=")
  ) {
    throw new Error("invalid argon2id verifier");
  }
  const version = Number.parseInt(ver.slice(4), 10);
  if (version !== 19) {
    throw new Error("unsupported argon2 version");
  }
  const parameters: Argon2idParameters = {
    encodingVersion: 1,
    argon2Version: 19,
    memoryKiB: Number.parseInt(memory.slice(2), 10),
    passes: Number.parseInt(passes.slice(2), 10),
    parallelism: Number.parseInt(parallelism.slice(2), 10),
    hashLength: Buffer.from(hashPart, "base64url").byteLength,
    saltLength: Buffer.from(saltPart, "base64url").byteLength,
  };
  return {
    parameters,
    salt: Buffer.from(saltPart, "base64url"),
    hash: Buffer.from(hashPart, "base64url"),
  };
}

async function deriveArgon2id(
  secret: Uint8Array,
  salt: Uint8Array,
  parameters: Argon2idParameters,
): Promise<Buffer> {
  const key = await crypto.subtle.importKey("raw-secret", secret, { name: "Argon2id" }, false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "Argon2id",
      nonce: salt,
      memory: parameters.memoryKiB,
      passes: parameters.passes,
      parallelism: parameters.parallelism,
      version: parameters.argon2Version,
    },
    key,
    parameters.hashLength * 8,
  );
  return Buffer.from(bits);
}
