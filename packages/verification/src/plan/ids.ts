import {
  sha256Utf8,
  taggedHash,
  type CheckId,
  type CheckNode,
  type ObjectDigest,
  type ObligationId,
  type ProofObligation,
} from "@pi-hec/contracts";
import { sha256HexToCrockford32 } from "@pi-hec/repository";
import { toJsonValue } from "./envelope.js";

function crockfordFromDigest(digest: string): string {
  return sha256HexToCrockford32(digest.slice("sha256:".length));
}

export function requireObjectDigest(value: string): ObjectDigest {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`invalid object digest ${value}`);
  }
  return value as ObjectDigest;
}

export function requireObligationId(value: string): ObligationId {
  if (!/^obl_[a-z2-7]{52}$/.test(value)) {
    throw new Error(`invalid obligation id ${value}`);
  }
  return value as ObligationId;
}

export function mintObligationId(input: {
  requirementIds: readonly string[];
  claim: string;
  kind: ProofObligation["kind"];
}): ObligationId {
  const digest = taggedHash("obligation-id", 1, {
    requirementIds: [...input.requirementIds],
    claim: input.claim,
    kind: input.kind,
  });
  return `obl_${crockfordFromDigest(digest)}`;
}

export function mintCheckId(input: {
  obligationIds: readonly string[];
  subject: CheckNode["subject"];
  recipe: CheckNode["recipe"];
}): CheckId {
  const digest = taggedHash("check-id", 1, {
    obligationIds: [...input.obligationIds],
    subject: input.subject,
    recipe: toJsonValue(input.recipe),
  });
  return `check_${crockfordFromDigest(digest)}`;
}

export function mintGeneralId(prefix: string, material: string): string {
  const digest = sha256Utf8(`${prefix}:${material}`);
  return `${prefix}-${crockfordFromDigest(digest).slice(0, 24)}`;
}
