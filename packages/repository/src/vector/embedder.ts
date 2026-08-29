import { createHash } from "node:crypto";
import { INDEX_TOOLCHAIN } from "../ingestion/types.js";
import { lexicalTokens } from "../fts/tokenize.js";

export const EMBEDDER_ID = INDEX_TOOLCHAIN.embedder;
export const VECTOR_DIMENSIONS = INDEX_TOOLCHAIN.vectorDimensions;

function fnv1a(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function embedText(text: string): Float32Array {
  const vec = new Float32Array(VECTOR_DIMENSIONS);
  const tokens = lexicalTokens(text);
  if (tokens.length === 0) {
    const digest = createHash("sha256").update(text, "utf8").digest();
    for (let index = 0; index < VECTOR_DIMENSIONS; index += 1) {
      const byte = digest[index % digest.byteLength] ?? 0;
      vec[index] = (byte - 128) / 128;
    }
  } else {
    for (const token of tokens) {
      const bucket = fnv1a(token) % VECTOR_DIMENSIONS;
      const sign = (fnv1a(`${token}\0sign`) & 1) === 0 ? 1 : -1;
      vec[bucket] = (vec[bucket] ?? 0) + sign;
    }
  }
  let norm = 0;
  for (const value of vec) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let index = 0; index < vec.length; index += 1) {
      vec[index] = (vec[index] ?? 0) / norm;
    }
  }
  return vec;
}

export function embeddingJson(vector: Float32Array): string {
  const parts: string[] = [];
  for (const value of vector) {
    parts.push(value.toFixed(8));
  }
  return `[${parts.join(",")}]`;
}
