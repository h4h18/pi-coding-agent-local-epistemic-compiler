import { Compile } from "typebox/compile";
import { DigestSchema, EvidenceIdSchema, SourceRefSchema, closed } from "@pi-hec/contracts";
import { Type, type Static } from "typebox";

export const EvidenceToolResultSchema = closed({
  evidenceIds: Type.Array(EvidenceIdSchema),
  sourceRefs: Type.Array(SourceRefSchema),
  quoteDigest: DigestSchema,
  contentDigest: DigestSchema,
});

export type EvidenceToolResult = Static<typeof EvidenceToolResultSchema>;

export const EVIDENCE_TOOL_RESULT = Compile(EvidenceToolResultSchema);

export function emptyToolResult(digest: EvidenceToolResult["quoteDigest"]): EvidenceToolResult {
  return {
    evidenceIds: [],
    sourceRefs: [],
    quoteDigest: digest,
    contentDigest: digest,
  };
}
