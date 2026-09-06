import { randomBytes } from "node:crypto";
import { Compile } from "typebox/compile";
import {
  ContextDeltaSchema,
  type CloudCallId,
  type ContextDelta,
  type ContextRequest,
  type Digest,
  type EvidenceBundle,
  type EvidenceGraph,
  type EvidenceId,
  type MaybePromise,
  type ObjectDigest,
  type RepairPacket,
  type RunId,
} from "@pi-hec/contracts";
import {
  detectNoProgress,
  isTemporaryCloudWait,
  type NoProgressReason,
  type TemporaryCloudWaitKind,
} from "@pi-hec/domain";
import {
  compileCloudContext,
  type CompilationOutcome,
  type CompilerInput,
} from "@pi-hec/context-compiler";
import { runAdaptivePreflight, type PreflightInput } from "@pi-hec/preflight";
import {
  buildRepairPacket,
  isRepairEligible,
  type BuildRepairPacketInput,
  type RepairPacketResult,
} from "@pi-hec/verification";
import type { CloudDispatchDecision } from "./cloud-dispatch.js";

const DELTA = Compile(ContextDeltaSchema);

const UNBOUNDED_REASON =
  /whole\s+(the\s+)?(repository|repo|codebase)|entire\s+(repository|repo|codebase)|all\s+files|dump\s+(the\s+)?(repo|repository)|unbounded|полный\s+репозитор|весь\s+репозитор|пришли\s+весь/i;

export function newCloudCallId(now = Date.now()): CloudCallId {
  const bytes = randomBytes(16);
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  const six = bytes[6] ?? 0;
  const eight = bytes[8] ?? 0;
  bytes[6] = (six & 0x0f) | 0x70;
  bytes[8] = (eight & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `call_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUnboundedContextRequest(request: ContextRequest): boolean {
  if (UNBOUNDED_REASON.test(request.reason)) {
    return true;
  }
  for (const hint of request.pathOrSymbolHints) {
    const trimmed = hint.trim();
    if (trimmed === "*" || trimmed === "**" || trimmed === "/" || trimmed === ".") {
      return true;
    }
    if (UNBOUNDED_REASON.test(trimmed)) {
      return true;
    }
  }
  return false;
}

export type RetrievedContextEvidence = {
  bundles: readonly EvidenceBundle[];
  resolvedClaimIds: readonly EvidenceId[];
  stillUnresolvedClaimIds: readonly EvidenceId[];
  payloadsPresent: boolean;
};

export function mapGraphToRetrieval(
  graph: EvidenceGraph,
  requestedClaimIds: readonly EvidenceId[],
): RetrievedContextEvidence {
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const resolved: EvidenceId[] = [];
  const still: EvidenceId[] = [];
  const bundles: EvidenceBundle[] = [];
  let payloadsPresent = true;
  for (const claimId of requestedClaimIds) {
    const node = byId.get(claimId);
    if (node === undefined) {
      still.push(claimId);
      continue;
    }
    resolved.push(claimId);
    const refs = node.provenance.map((item) => item.source);
    if (refs.length === 0 || node.contentObjectDigest === undefined) {
      payloadsPresent = false;
    }
    bundles.push({
      id: `bundle-${claimId}`,
      purpose: "causal-path",
      nodeIds: [claimId],
      edgeIds: [],
      exactSourceRefs: refs,
      mandatory: true,
    });
  }
  return {
    bundles,
    resolvedClaimIds: resolved,
    stillUnresolvedClaimIds: still,
    payloadsPresent,
  };
}

export async function retrieveWithAdaptivePreflight(
  input: PreflightInput,
  requestedClaimIds: readonly EvidenceId[],
): Promise<RetrievedContextEvidence> {
  const result = await runAdaptivePreflight(input);
  return mapGraphToRetrieval(result.graph, requestedClaimIds);
}

export function compileFollowUpContext(input: CompilerInput): CompilationOutcome {
  return compileCloudContext({ ...input, purpose: "context-followup" });
}

export function compileRepairContext(input: CompilerInput): CompilationOutcome {
  return compileCloudContext({ ...input, purpose: "repair" });
}

export type ContextFollowUpDispatch = {
  dispatch: CloudDispatchDecision;
  completionCount: number;
};

export type ContextFallbackInput = {
  request: ContextRequest;
  runId: RunId;
  cloudCallId: CloudCallId;
  priorContextPacketObjectDigest: ObjectDigest;
  unresolvedClaimIds: readonly EvidenceId[];
  retrieve: (input: {
    claimIds: readonly EvidenceId[];
    hints: readonly string[];
    kinds: readonly string[];
  }) => MaybePromise<RetrievedContextEvidence>;
  compileAndDispatch: (input: {
    cloudCallId: CloudCallId;
    contextDelta: ContextDelta;
    retrieval: RetrievedContextEvidence;
  }) => MaybePromise<ContextFollowUpDispatch>;
  mintCloudCallId?: () => CloudCallId;
};

export type ContextFallbackFailureCode =
  "REQUEST_BINDING_MISMATCH" | "UNKNOWN_CLAIM_ID" | "DIGEST_ONLY_EVIDENCE";

export type ContextFallbackResult =
  | { kind: "unbounded-rejected"; code: "UNBOUNDED_CONTEXT_REQUEST" }
  | { kind: "failed"; code: ContextFallbackFailureCode; reason: string }
  | {
      kind: "follow-up";
      contextDelta: ContextDelta;
      cloudCallId: CloudCallId;
      completionCount: number;
      dispatch: CloudDispatchDecision;
    };

export function buildContextDelta(input: {
  runId: RunId;
  priorContextPacketObjectDigest: ObjectDigest;
  requestedByCloudCallId: CloudCallId;
  bundles: readonly EvidenceBundle[];
  resolvedClaimIds: readonly EvidenceId[];
  stillUnresolvedClaimIds: readonly EvidenceId[];
}): ContextDelta {
  const delta: ContextDelta = {
    schemaVersion: 1,
    runId: input.runId,
    priorContextPacketObjectDigest: input.priorContextPacketObjectDigest,
    requestedByCloudCallId: input.requestedByCloudCallId,
    evidenceBundles: [...input.bundles],
    resolvedClaimIds: [...input.resolvedClaimIds],
    stillUnresolvedClaimIds: [...input.stillUnresolvedClaimIds],
  };
  if (!DELTA.Check(delta)) {
    throw new Error("ContextDelta failed schema validation");
  }
  return delta;
}

export async function handleContextFallback(
  input: ContextFallbackInput,
): Promise<ContextFallbackResult> {
  if (isUnboundedContextRequest(input.request)) {
    return { kind: "unbounded-rejected", code: "UNBOUNDED_CONTEXT_REQUEST" };
  }
  if (input.request.runId !== input.runId || input.request.cloudCallId !== input.cloudCallId) {
    return {
      kind: "failed",
      code: "REQUEST_BINDING_MISMATCH",
      reason: "request_context is not bound to the dispatched run and cloud call",
    };
  }
  const known = new Map<string, EvidenceId>(
    input.unresolvedClaimIds.map((claimId) => [claimId, claimId]),
  );
  const claimIds: EvidenceId[] = [];
  for (const claimId of input.request.missingClaimIds) {
    const bound = known.get(claimId);
    if (bound === undefined) {
      return {
        kind: "failed",
        code: "UNKNOWN_CLAIM_ID",
        reason: "missingClaimId is not unresolved in the bound packet",
      };
    }
    claimIds.push(bound);
  }
  const retrieval = await input.retrieve({
    claimIds,
    hints: input.request.pathOrSymbolHints,
    kinds: input.request.requestedEvidenceKinds,
  });
  if (!retrieval.payloadsPresent) {
    return {
      kind: "failed",
      code: "DIGEST_ONLY_EVIDENCE",
      reason: "admitted evidence missing inline body",
    };
  }
  const contextDelta = buildContextDelta({
    runId: input.runId,
    priorContextPacketObjectDigest: input.priorContextPacketObjectDigest,
    requestedByCloudCallId: input.cloudCallId,
    bundles: retrieval.bundles,
    resolvedClaimIds: retrieval.resolvedClaimIds,
    stillUnresolvedClaimIds: retrieval.stillUnresolvedClaimIds,
  });
  const cloudCallId =
    input.mintCloudCallId === undefined ? newCloudCallId() : input.mintCloudCallId();
  const follow = await input.compileAndDispatch({
    cloudCallId,
    contextDelta,
    retrieval,
  });
  return {
    kind: "follow-up",
    contextDelta,
    cloudCallId,
    completionCount: follow.completionCount,
    dispatch: follow.dispatch,
  };
}

export type RepairCompileDispatch =
  | { kind: "waiting"; state: string; reason: string }
  | { kind: "dispatched"; dispatch: CloudDispatchDecision; completionCount: number };

export type RepairOrchestrationInput = {
  fingerprint: Digest;
  previousFingerprints: readonly Digest[];
  hasNormalizedDelta: boolean;
  touchesCausalSliceOrAddsEvidence: boolean;
  regressesPreservedPassingObligations: boolean;
  cloudResultRepeated: boolean;
  adapterKind?: CloudDispatchDecision["kind"] | TemporaryCloudWaitKind;
  repair: BuildRepairPacketInput;
  compileAndDispatch: (input: {
    cloudCallId: CloudCallId;
    packet: RepairPacket;
    purpose: "repair";
  }) => MaybePromise<RepairCompileDispatch>;
  mintCloudCallId?: () => CloudCallId;
};

export type RepairOrchestrationResult =
  | { kind: "waiting"; adapter: TemporaryCloudWaitKind; dispatched: false }
  | {
      kind: "no-progress";
      reason: NoProgressReason;
      nextState: "PAUSED_NO_PROGRESS";
      guard: "NO_PROGRESS_POLICY_SATISFIED";
      dispatched: false;
    }
  | {
      kind: "prepared";
      packet: RepairPacket;
      nextState: "REPAIR_PREPARING";
      dispatched: boolean;
      cloudCallId: CloudCallId;
      dispatch: CloudDispatchDecision;
      completionCount: number;
    }
  | {
      kind: "compile-waiting";
      state: string;
      reason: string;
      packet: RepairPacket;
      nextState: "REPAIR_PREPARING";
      dispatched: false;
      cloudCallId: CloudCallId;
    }
  | { kind: "ineligible"; code: string; dispatched: false }
  | {
      kind: "refused";
      code: Extract<RepairPacketResult, { ok: false }>["code"];
      dispatched: false;
    };

function repairDispatchCompleted(
  decision: CloudDispatchDecision,
  completionCount: number,
): boolean {
  switch (decision.kind) {
    case "completed":
    case "already-owned":
      return completionCount > 0;
    case "waiting-provider":
    case "outcome-unknown":
    case "not-dispatched":
      return false;
    default: {
      const exhaustive: never = decision;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export async function handleRepairAfterVerdict(
  input: RepairOrchestrationInput,
): Promise<RepairOrchestrationResult> {
  if (input.adapterKind !== undefined && isTemporaryCloudWait(input.adapterKind)) {
    return { kind: "waiting", adapter: input.adapterKind, dispatched: false };
  }
  const reason = detectNoProgress({
    fingerprint: input.fingerprint,
    previousFingerprints: input.previousFingerprints,
    hasNormalizedDelta: input.hasNormalizedDelta,
    touchesCausalSliceOrAddsEvidence: input.touchesCausalSliceOrAddsEvidence,
    regressesPreservedPassingObligations: input.regressesPreservedPassingObligations,
    cloudResultRepeated: input.cloudResultRepeated,
  });
  if (reason !== undefined) {
    return {
      kind: "no-progress",
      reason,
      nextState: "PAUSED_NO_PROGRESS",
      guard: "NO_PROGRESS_POLICY_SATISFIED",
      dispatched: false,
    };
  }
  if (!isRepairEligible(input.repair)) {
    return { kind: "ineligible", code: "REPAIR_NOT_ELIGIBLE", dispatched: false };
  }
  const built = buildRepairPacket(input.repair);
  if (!built.ok) {
    return { kind: "refused", code: built.code, dispatched: false };
  }
  const cloudCallId =
    input.mintCloudCallId === undefined ? newCloudCallId() : input.mintCloudCallId();
  const compiled = await input.compileAndDispatch({
    cloudCallId,
    packet: built.packet,
    purpose: "repair",
  });
  switch (compiled.kind) {
    case "waiting":
      return {
        kind: "compile-waiting",
        state: compiled.state,
        reason: compiled.reason,
        packet: built.packet,
        nextState: "REPAIR_PREPARING",
        dispatched: false,
        cloudCallId,
      };
    case "dispatched":
      return {
        kind: "prepared",
        packet: built.packet,
        nextState: "REPAIR_PREPARING",
        dispatched: repairDispatchCompleted(compiled.dispatch, compiled.completionCount),
        cloudCallId,
        dispatch: compiled.dispatch,
        completionCount: compiled.completionCount,
      };
    default: {
      const exhaustive: never = compiled;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}
