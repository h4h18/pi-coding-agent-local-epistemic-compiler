import type { ObjectDigest, SnapshotEntry } from "@pi-hec/contracts";
import type { BlobGetter } from "./types.js";

const CHUNK_BYTES = 4 * 1024 * 1024;

export class SnapshotReadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SnapshotReadError";
    this.code = code;
  }
}

export async function loadSnapshotFileBytes(
  entry: Extract<SnapshotEntry, { entryType: "file" }>,
  getBlob: BlobGetter,
): Promise<Uint8Array> {
  if (entry.storage.kind === "blob") {
    const bytes = await getBlob(entry.storage.objectDigest as ObjectDigest);
    if (bytes.byteLength !== entry.size) {
      throw new SnapshotReadError("SIZE_MISMATCH", `file ${entry.path} size mismatch`);
    }
    return bytes;
  }
  const chunks = [...entry.storage.chunks].sort((left, right) => left.offset - right.offset);
  if (chunks[0]?.offset !== 0) {
    throw new SnapshotReadError("CHUNK_GAP", `file ${entry.path} chunks must start at 0`);
  }
  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.offset !== cursor) {
      throw new SnapshotReadError("CHUNK_GAP", `file ${entry.path} chunk gap or overlap`);
    }
    if (chunk.length <= 0 || chunk.length > CHUNK_BYTES) {
      throw new SnapshotReadError("CHUNK_LENGTH", `file ${entry.path} invalid chunk length`);
    }
    const bytes = await getBlob(chunk.digest as ObjectDigest);
    if (bytes.byteLength !== chunk.length) {
      throw new SnapshotReadError(
        "CHUNK_LENGTH",
        `file ${entry.path} chunk object length mismatch`,
      );
    }
    parts.push(bytes);
    cursor += chunk.length;
  }
  if (cursor !== entry.size) {
    throw new SnapshotReadError("SIZE_MISMATCH", `file ${entry.path} reconstructed size mismatch`);
  }
  const out = new Uint8Array(cursor);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
