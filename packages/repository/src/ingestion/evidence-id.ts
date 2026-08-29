import {
  taggedHash,
  type EvidenceId,
  type EvidenceNodeKind,
  type JsonValue,
  type ObjectDigest,
  type SnapshotId,
} from "@pi-hec/contracts";
import type { UnitKind } from "./types.js";

const CROCKFORD = "abcdefghijklmnopqrstuvwxyz234567";

export function sha256HexToCrockford32(hex: string): string {
  const bytes = Buffer.from(hex, "hex");
  if (bytes.byteLength !== 32) {
    throw new Error("sha256 digest must be 32 bytes");
  }
  let bits = "";
  for (const value of bytes) {
    bits += value.toString(2).padStart(8, "0");
  }
  bits = bits.padEnd(260, "0");
  let out = "";
  for (let index = 0; index < 52; index += 1) {
    const slice = bits.slice(index * 5, index * 5 + 5);
    out += CROCKFORD[Number.parseInt(slice, 2)] ?? "a";
  }
  return out;
}

export function evidenceIdFromNode(input: {
  snapshotId: SnapshotId;
  kind: EvidenceNodeKind;
  identityKey: string;
  contentObjectDigest?: ObjectDigest;
  provenanceIdentities: readonly string[];
}): EvidenceId {
  const payload: { [key: string]: JsonValue } = {
    snapshotId: input.snapshotId,
    kind: input.kind,
    identityKey: input.identityKey,
    provenanceIdentities: [...input.provenanceIdentities].sort(),
  };
  if (input.contentObjectDigest !== undefined) {
    payload.contentObjectDigest = input.contentObjectDigest;
  }
  const digest = taggedHash("evidence-node", 1, payload);
  return `evidence_${sha256HexToCrockford32(digest.slice("sha256:".length))}`;
}

export function evidenceKindForUnit(kind: UnitKind): EvidenceNodeKind {
  switch (kind) {
    case "function":
    case "method":
    case "class":
    case "top-level":
      return "symbol";
    case "test":
      return "test";
    case "schema-object":
      return "schema";
    case "config-block":
      return "build-config";
    case "commit":
      return "commit";
    case "diff":
      return "diff-hunk";
    case "directory":
      return "directory";
    case "file":
    case "markdown-section":
    case "fallback-window":
      return "code-region";
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled unit kind ${String(exhaustive)}`);
    }
  }
}
