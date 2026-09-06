import {
  asCandidateId,
  asCheckId,
  asEvidenceId,
  asObjectDigest,
  asRequirementId,
  asRunId,
  asSnapshotId,
  type RetrievalAction,
} from "@pi-hec/contracts";

export const DIGEST = asObjectDigest("sha256:" + "ab".repeat(32));
export const SNAP = asSnapshotId("snap_01234567-89ab-7cde-8f01-23456789abcd");
export const RUN = asRunId("run_01234567-89ab-7cde-8f01-23456789abcd");
export const CANDIDATE = asCandidateId("candidate_01234567-89ab-7cde-8f01-23456789abcd");
export const EVIDENCE = asEvidenceId("evidence_" + "a".repeat(52));
export const REQ = asRequirementId("req_" + "a".repeat(52));
export const CHECK = asCheckId("check_" + "a".repeat(52));

export function loopbackSeal(port: number) {
  return {
    providerId: "hec-local",
    modelId: "hec-analyst",
    modelRevision: "test-loopback-1",
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    name: "HEC local analyst",
    contextWindow: 8192,
    maxTokens: 2048,
  };
}

export function sampleAction(): RetrievalAction {
  return {
    id: "action-1",
    channelId: "lexical",
    targetClaimIds: [EVIDENCE],
    query: "symbol n",
    filters: {},
    expectedInformationGain: 0.4,
    expectedTrustGain: 0.3,
    estimatedLatencyMs: 10,
    estimatedPacketTokens: 32,
  };
}

export function sampleAuditUnknown() {
  return {
    proposalId: "unknown-1",
    kind: "unknown" as const,
    statement: "missing runtime witness for n",
    citedSourceRefs: [],
    targetClaimIds: [EVIDENCE],
    requestedReproductionActions: [sampleAction()],
  };
}

export function throwingPromotionSinks(): {
  called: boolean;
  changeSetBuilder: (text: string) => void;
  promotionPath: (text: string) => void;
  egressHelper: (text: string) => void;
} {
  const state = { called: false };
  const boom = (label: string) => (text: string) => {
    state.called = true;
    throw new Error(`${label} must not receive local analyst text: ${text.slice(0, 80)}`);
  };
  return {
    get called() {
      return state.called;
    },
    changeSetBuilder: boom("ChangeSet builder"),
    promotionPath: boom("promotion path"),
    egressHelper: boom("egress helper"),
  };
}
