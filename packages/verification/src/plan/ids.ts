import {
  sha256Utf8,
  taggedHash,
  type CheckId,
  type CheckNode,
  type ObligationId,
  type ProofObligation,
} from "@pi-hec/contracts";
import { sha256HexToCrockford32 } from "@pi-hec/repository";
import { toJsonValue } from "@pi-hec/contracts";

function crockfordFromDigest(digest: string): string {
  return sha256HexToCrockford32(digest.slice("sha256:".length));
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
