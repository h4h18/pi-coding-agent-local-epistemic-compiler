import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { writeOwnerOnlyFile } from "./owner-mode.js";

export const RESTIC_VERSION = "0.19.1";
const NONCE_BYTES = 16;
const MAC_BYTES = 16;
const P = (1n << 130n) - 5n;

export type ResticMasterKey = {
  encrypt: Buffer;
  macK: Buffer;
  macR: Buffer;
};

export function createMasterKey(): ResticMasterKey {
  return {
    encrypt: randomBytes(32),
    macK: randomBytes(16),
    macR: clampR(randomBytes(16)),
  };
}

export function resticSeal(key: ResticMasterKey, plaintext: Uint8Array): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = aesCtr(key.encrypt, nonce, Buffer.from(plaintext));
  const mac = poly1305Aes(key, nonce, ciphertext);
  return Buffer.concat([nonce, ciphertext, mac]);
}

export function resticOpen(key: ResticMasterKey, sealed: Uint8Array): Buffer {
  if (sealed.byteLength < NONCE_BYTES + MAC_BYTES) {
    throw new Error("restic blob truncated");
  }
  const nonce = Buffer.from(sealed.subarray(0, NONCE_BYTES));
  const mac = Buffer.from(sealed.subarray(sealed.byteLength - MAC_BYTES));
  const ciphertext = Buffer.from(sealed.subarray(NONCE_BYTES, sealed.byteLength - MAC_BYTES));
  const expected = poly1305Aes(key, nonce, ciphertext);
  if (!expected.equals(mac)) {
    throw new Error("restic MAC unauthenticated");
  }
  return aesCtr(key.encrypt, nonce, ciphertext);
}

export function initResticRepo(repoPath: string, key: ResticMasterKey): void {
  mkdirSync(path.join(repoPath, "keys"), { recursive: true });
  mkdirSync(path.join(repoPath, "snapshots"), { recursive: true });
  mkdirSync(path.join(repoPath, "index"), { recursive: true });
  mkdirSync(path.join(repoPath, "data"), { recursive: true });
  mkdirSync(path.join(repoPath, "locks"), { recursive: true });
  const config = Buffer.from(
    JSON.stringify({
      version: 2,
      id: createHash("sha256").update(key.encrypt).digest("hex"),
      chunker_polynomial: "25b468838dcb75",
      restic: RESTIC_VERSION,
    }),
    "utf8",
  );
  writeOwnerOnlyFile(path.join(repoPath, "config"), resticSeal(key, config));
}

export function putResticBlob(
  repoPath: string,
  key: ResticMasterKey,
  kind: "data" | "snapshots" | "index",
  bytes: Uint8Array,
): string {
  const sealed = resticSeal(key, bytes);
  const id = createHash("sha256").update(sealed).digest("hex");
  if (kind === "data") {
    const dir = path.join(repoPath, "data", id.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    writeOwnerOnlyFile(path.join(dir, id), sealed);
  } else {
    writeOwnerOnlyFile(path.join(repoPath, kind, id), sealed);
  }
  return id;
}

export function readResticBlob(
  repoPath: string,
  key: ResticMasterKey,
  kind: "data" | "snapshots" | "index",
  id: string,
): Buffer {
  const filePath =
    kind === "data"
      ? path.join(repoPath, "data", id.slice(0, 2), id)
      : path.join(repoPath, kind, id);
  return resticOpen(key, readFileSync(filePath));
}

export function verifyResticRepo(repoPath: string, key: ResticMasterKey): void {
  resticOpen(key, readFileSync(path.join(repoPath, "config")));
  for (const kind of ["snapshots", "index"] as const) {
    const dir = path.join(repoPath, kind);
    for (const name of readdirSync(dir)) {
      resticOpen(key, readFileSync(path.join(dir, name)));
    }
  }
  const dataRoot = path.join(repoPath, "data");
  if (!statSync(dataRoot).isDirectory()) {
    return;
  }
  for (const bucket of readdirSync(dataRoot)) {
    const bucketDir = path.join(dataRoot, bucket);
    if (!statSync(bucketDir).isDirectory()) {
      continue;
    }
    for (const name of readdirSync(bucketDir)) {
      resticOpen(key, readFileSync(path.join(bucketDir, name)));
    }
  }
}

function aesCtr(key: Buffer, nonce: Buffer, data: Buffer): Buffer {
  const iv = Buffer.alloc(16);
  nonce.copy(iv, 0, 0, Math.min(16, nonce.length));
  const cipher = createCipheriv("aes-256-ctr", key, iv);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function poly1305Aes(key: ResticMasterKey, nonce: Buffer, ciphertext: Buffer): Buffer {
  const sBlock = Buffer.alloc(16);
  nonce.copy(sBlock, 0, 0, 16);
  const aes = createCipheriv("aes-128-ecb", key.macK, null);
  aes.setAutoPadding(false);
  const s = Buffer.concat([aes.update(sBlock), aes.final()]).subarray(0, 16);
  return poly1305(key.macR, s, ciphertext);
}

function clampR(raw: Buffer): Buffer {
  const r = Buffer.from(raw);
  r[3] = (r[3] ?? 0) & 15;
  r[7] = (r[7] ?? 0) & 15;
  r[11] = (r[11] ?? 0) & 15;
  r[15] = (r[15] ?? 0) & 15;
  r[4] = (r[4] ?? 0) & 252;
  r[8] = (r[8] ?? 0) & 252;
  r[12] = (r[12] ?? 0) & 252;
  return r;
}

function poly1305(rBytes: Buffer, sBytes: Buffer, message: Buffer): Buffer {
  const r = le16(rBytes);
  const s = le16(sBytes);
  let acc = 0n;
  for (let offset = 0; offset < message.length; offset += 16) {
    const block = message.subarray(offset, offset + 16);
    const padded = Buffer.alloc(17);
    padded.set(block);
    padded[block.length] = 1;
    acc = ((acc + le17(padded)) * r) % P;
  }
  acc = (acc + s) % (1n << 128n);
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number((acc >> BigInt(8 * i)) & 0xffn);
  }
  return out;
}

function le16(bytes: Buffer): bigint {
  let value = 0n;
  for (let i = 0; i < 16; i += 1) {
    value |= BigInt(bytes[i] ?? 0) << BigInt(8 * i);
  }
  return value;
}

function le17(bytes: Buffer): bigint {
  let value = 0n;
  for (let i = 0; i < 17; i += 1) {
    value |= BigInt(bytes[i] ?? 0) << BigInt(8 * i);
  }
  return value;
}
