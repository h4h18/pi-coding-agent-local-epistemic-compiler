import { Compile } from "typebox/compile";
import {
  ClosureReportSchema,
  EvidenceGraphSchema,
  canonicalizeRfc8785,
  type ClosureReport,
  type EvidenceGraph,
  type ObjectDigest,
} from "@pi-hec/contracts";
import type { BlobStore, PutObjectResult } from "@pi-hec/cas";
import { runAdaptivePreflight, type PreflightInput, type PreflightResult } from "@pi-hec/preflight";

const GRAPH = Compile(EvidenceGraphSchema);
const CLOSURE = Compile(ClosureReportSchema);

export type HandlePreflightInput = PreflightInput & {
  projectId: string;
  cas: BlobStore;
};

export type HandlePreflightResult = PreflightResult & {
  evidenceGraphObjectDigest: ObjectDigest;
  closureReportObjectDigest: ObjectDigest;
};

async function persistJson(
  cas: BlobStore,
  projectId: string,
  schemaName: "EvidenceGraph" | "ClosureReport",
  payload: EvidenceGraph | ClosureReport,
): Promise<PutObjectResult> {
  const bytes = Buffer.from(canonicalizeRfc8785(payload), "utf8");
  return cas.putObject({
    projectId,
    bytes,
    mediaType: "application/json",
    classification: "internal",
    schemaName,
  });
}

export async function handlePreflight(input: HandlePreflightInput): Promise<HandlePreflightResult> {
  const result = await runAdaptivePreflight(input);
  if (!GRAPH.Check(result.graph)) {
    throw new Error("preflight evidence graph failed schema validation");
  }
  if (!CLOSURE.Check(result.closure)) {
    throw new Error("preflight closure report failed schema validation");
  }
  const graphPut = await persistJson(input.cas, input.projectId, "EvidenceGraph", result.graph);
  const closurePut = await persistJson(input.cas, input.projectId, "ClosureReport", result.closure);
  return {
    ...result,
    evidenceGraphObjectDigest: graphPut.objectDigest,
    closureReportObjectDigest: closurePut.objectDigest,
  };
}
