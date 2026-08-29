import { expect, test } from "vitest";
import { sha256Utf8, type CloudCallId, type Digest } from "@pi-hec/contracts";
import { computeStateFingerprint, detectNoProgress } from "@pi-hec/domain";
import { handleRepairAfterVerdict } from "../src/orchestration/handlers.js";
import type { RepairCompileDispatch, RepairOrchestrationInput } from "../src/services/context-jobs.js";
import {
  CANDIDATE,
  CHECK_A,
  CHECK_B,
  OBJECT,
  OBL_FAIL,
  OBL_PASS,
  RUN,
  SNAP,
  admissibleAssessment,
  checkNode,
  failEvidence,
  failObligation,
  inadmissibleAssessment,
  passObligation,
  planWith,
  rejectedReport,
  utf8Artifact,
} from "../../../packages/verification/test/repair/helpers.ts";

const ROOT = sha256Utf8("snapshot-root");
const TREE = sha256Utf8("tree");
const PRIOR_CALL = "call_01234567-89ab-7cde-8f01-23456789abcd" as CloudCallId;
const NEXT_CALL = "call_01234567-89ab-7cde-8f01-23456789abce" as CloudCallId;

function fingerprintAt(label: string): Digest {
  return computeStateFingerprint({
    baseSnapshotId: SNAP,
    baseSnapshotRootDigest: ROOT,
    operations: [{ kind: "create_directory", path: "src", expectedAbsent: true }],
    materializedTreeDigest: TREE,
    obligationStatusVector: [
      { obligationId: OBL_FAIL, status: "FAIL" },
      { obligationId: OBL_PASS, status: "PASS" },
    ],
    failureSignatures: ["sig"],
    evidenceRootDigest: sha256Utf8(label),
  });
}

function waitingProviderCompile(): RepairOrchestrationInput["compileAndDispatch"] {
  return async () => ({
    kind: "dispatched",
    dispatch: { kind: "waiting-provider" },
    completionCount: 0,
  });
}

function repairInput(overrides: Partial<ReturnType<typeof repairDefaults>> = {}) {
  return {
    ...repairDefaults(),
    ...overrides,
  };
}

function repairDefaults() {
  return {
    runId: RUN,
    baseSnapshotId: SNAP,
    priorCandidateId: CANDIDATE,
    priorCandidateManifestObjectDigest: OBJECT,
    plan: planWith(
      [checkNode(CHECK_A, [OBL_FAIL]), checkNode(CHECK_B, [OBL_PASS])],
      [failObligation(), passObligation()],
    ),
    report: rejectedReport({
      evidenceAssessments: [admissibleAssessment()],
    }),
    checkResults: new Map([
      [CHECK_A, "FAIL" as const],
      [CHECK_B, "PASS" as const],
    ]),
    failureArtifacts: [utf8Artifact("test log line")],
    evidence: [failEvidence("VERIFIER")],
  };
}

function progressOk(): Pick<
  RepairOrchestrationInput,
  | "fingerprint"
  | "previousFingerprints"
  | "hasNormalizedDelta"
  | "touchesCausalSliceOrAddsEvidence"
  | "regressesPreservedPassingObligations"
  | "cloudResultRepeated"
> {
  return {
    fingerprint: fingerprintAt("novel-ok"),
    previousFingerprints: [],
    hasNormalizedDelta: true,
    touchesCausalSliceOrAddsEvidence: true,
    regressesPreservedPassingObligations: false,
    cloudResultRepeated: false,
  };
}

test("unlimited novel repairs proceed with new evidence and no MAX_REPAIRS", async () => {
  const previous: Digest[] = [];
  for (let index = 0; index < 9; index += 1) {
    const current = fingerprintAt(`novel-${String(index)}`);
    expect(
      detectNoProgress({
        fingerprint: current,
        previousFingerprints: previous,
        hasNormalizedDelta: true,
        touchesCausalSliceOrAddsEvidence: true,
        regressesPreservedPassingObligations: false,
        cloudResultRepeated: false,
      }),
    ).toBeUndefined();
    const result = await handleRepairAfterVerdict({
      fingerprint: current,
      previousFingerprints: previous,
      hasNormalizedDelta: true,
      touchesCausalSliceOrAddsEvidence: true,
      regressesPreservedPassingObligations: false,
      cloudResultRepeated: false,
      repair: repairInput(),
      compileAndDispatch: waitingProviderCompile(),
      mintCloudCallId: () => NEXT_CALL,
    });
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") {
      throw new Error("expected prepared");
    }
    expect(result.dispatched).toBe(false);
    expect(result.packet.requiredResponse).toBe("FULL_REPLACEMENT_CHANGESET");
    previous.push(current);
  }
});

test("repeated fingerprint cycle empty delta miss causal slice regression and repeated cloud result pause without dispatch", async () => {
  const current = fingerprintAt("same");
  const cases = [
    {
      previousFingerprints: [current],
      hasNormalizedDelta: true,
      touchesCausalSliceOrAddsEvidence: true,
      regressesPreservedPassingObligations: false,
      cloudResultRepeated: false,
      reason: "FINGERPRINT_REPEATED",
    },
    {
      previousFingerprints: [current, sha256Utf8("other")],
      hasNormalizedDelta: true,
      touchesCausalSliceOrAddsEvidence: true,
      regressesPreservedPassingObligations: false,
      cloudResultRepeated: false,
      reason: "FINGERPRINT_CYCLE",
    },
    {
      previousFingerprints: [],
      hasNormalizedDelta: false,
      touchesCausalSliceOrAddsEvidence: true,
      regressesPreservedPassingObligations: false,
      cloudResultRepeated: false,
      reason: "CHANGESET_WITHOUT_DELTA",
    },
    {
      previousFingerprints: [],
      hasNormalizedDelta: true,
      touchesCausalSliceOrAddsEvidence: false,
      regressesPreservedPassingObligations: false,
      cloudResultRepeated: false,
      reason: "CANDIDATE_MISSES_CAUSAL_SLICE",
    },
    {
      previousFingerprints: [],
      hasNormalizedDelta: true,
      touchesCausalSliceOrAddsEvidence: true,
      regressesPreservedPassingObligations: true,
      cloudResultRepeated: false,
      reason: "PRESERVED_OBLIGATION_REGRESSION",
    },
    {
      previousFingerprints: [],
      hasNormalizedDelta: true,
      touchesCausalSliceOrAddsEvidence: true,
      regressesPreservedPassingObligations: false,
      cloudResultRepeated: true,
      reason: "CLOUD_RESULT_REPEATED",
    },
  ] as const;
  for (const item of cases) {
    const result = await handleRepairAfterVerdict({
      fingerprint: current,
      previousFingerprints: item.previousFingerprints,
      hasNormalizedDelta: item.hasNormalizedDelta,
      touchesCausalSliceOrAddsEvidence: item.touchesCausalSliceOrAddsEvidence,
      regressesPreservedPassingObligations: item.regressesPreservedPassingObligations,
      cloudResultRepeated: item.cloudResultRepeated,
      repair: repairInput(),
      compileAndDispatch: async () => {
        throw new Error("compile must not run on no-progress");
      },
    });
    expect(result.kind).toBe("no-progress");
    if (result.kind !== "no-progress") {
      throw new Error("expected no-progress");
    }
    expect(result.reason).toBe(item.reason);
    expect(result.nextState).toBe("PAUSED_NO_PROGRESS");
    expect(result.guard).toBe("NO_PROGRESS_POLICY_SATISFIED");
    expect(result.dispatched).toBe(false);
  }
});

test("temporary adapter not-dispatched and waiting are not no-progress and do not dispatch", async () => {
  const current = fingerprintAt("wait");
  for (const adapterKind of ["not-dispatched", "waiting-provider"] as const) {
    const result = await handleRepairAfterVerdict({
      fingerprint: current,
      previousFingerprints: [current],
      hasNormalizedDelta: false,
      touchesCausalSliceOrAddsEvidence: false,
      regressesPreservedPassingObligations: true,
      cloudResultRepeated: true,
      adapterKind,
      repair: repairInput(),
      compileAndDispatch: async () => {
        throw new Error("compile must not run while adapter is waiting");
      },
    });
    expect(result.kind).toBe("waiting");
    if (result.kind !== "waiting") {
      throw new Error("expected waiting");
    }
    expect(result.adapter).toBe(adapterKind);
    expect(result.dispatched).toBe(false);
  }
});

test("LOCAL_MODEL-only CONFIRMED CLOUD failure is ineligible; deterministic evidence is eligible", async () => {
  const local = await handleRepairAfterVerdict({
    ...progressOk(),
    repair: repairInput({
      report: rejectedReport({
        evidenceAssessments: [inadmissibleAssessment("ev-fail", "LOCAL_MODEL")],
      }),
      evidence: [failEvidence("LOCAL_MODEL")],
    }),
    compileAndDispatch: async () => {
      throw new Error("compile must not run when ineligible");
    },
  });
  expect(local.kind).toBe("ineligible");
  if (local.kind !== "ineligible") {
    throw new Error("expected ineligible");
  }
  expect(local.dispatched).toBe(false);
  const sandbox = await handleRepairAfterVerdict({
    ...progressOk(),
    repair: repairInput({
      report: rejectedReport({
        evidenceAssessments: [admissibleAssessment()],
      }),
      evidence: [failEvidence("INDEPENDENT_TOOL")],
    }),
    compileAndDispatch: waitingProviderCompile(),
    mintCloudCallId: () => NEXT_CALL,
  });
  expect(sandbox.kind).toBe("prepared");
  if (sandbox.kind !== "prepared") {
    throw new Error("expected prepared");
  }
  expect(sandbox.dispatched).toBe(false);
});

test("missing provider-wire approval prepares packet without a second completion", async () => {
  let compileCalls = 0;
  const purposes: string[] = [];
  const result = await handleRepairAfterVerdict({
    ...progressOk(),
    repair: repairInput(),
    compileAndDispatch: async ({ cloudCallId, purpose }) => {
      compileCalls += 1;
      purposes.push(purpose);
      expect(cloudCallId).toBe(NEXT_CALL);
      expect(cloudCallId).not.toBe(PRIOR_CALL);
      return {
        kind: "dispatched",
        dispatch: { kind: "waiting-provider" },
        completionCount: 0,
      };
    },
    mintCloudCallId: () => NEXT_CALL,
  });
  expect(result.kind).toBe("prepared");
  if (result.kind !== "prepared") {
    throw new Error("expected prepared");
  }
  expect(result.packet.requiredResponse).toBe("FULL_REPLACEMENT_CHANGESET");
  expect(result.dispatched).toBe(false);
  expect(result.nextState).toBe("REPAIR_PREPARING");
  expect(result.cloudCallId).toBe(NEXT_CALL);
  expect(compileCalls).toBe(1);
  expect(purposes).toEqual(["repair"]);
  expect(result.completionCount).toBe(0);
});

test("approved repair compile dispatches once with a new CloudCallId", async () => {
  let compileCalls = 0;
  const result = await handleRepairAfterVerdict({
    ...progressOk(),
    repair: repairInput(),
    compileAndDispatch: async ({ cloudCallId, purpose, packet }) => {
      compileCalls += 1;
      expect(purpose).toBe("repair");
      expect(cloudCallId).toBe(NEXT_CALL);
      expect(cloudCallId).not.toBe(PRIOR_CALL);
      expect(packet.requiredResponse).toBe("FULL_REPLACEMENT_CHANGESET");
      return { kind: "dispatched", dispatch: { kind: "already-owned" }, completionCount: 1 };
    },
    mintCloudCallId: () => NEXT_CALL,
  });
  expect(result.kind).toBe("prepared");
  if (result.kind !== "prepared") {
    throw new Error("expected prepared");
  }
  expect(result.dispatched).toBe(true);
  expect(result.cloudCallId).toBe(NEXT_CALL);
  expect(result.cloudCallId).not.toBe(PRIOR_CALL);
  expect(compileCalls).toBe(1);
  expect(result.completionCount).toBe(1);
});

test("compile WAITING_* is waiting not no-progress", async () => {
  const result = await handleRepairAfterVerdict({
    ...progressOk(),
    repair: repairInput(),
    compileAndDispatch: async () =>
      ({
        kind: "waiting",
        state: "WAITING_REPAIR_CONTEXT_CAPACITY",
        reason: "repair packet exceeds context capacity",
      }) satisfies RepairCompileDispatch,
    mintCloudCallId: () => NEXT_CALL,
  });
  expect(result.kind).toBe("compile-waiting");
  if (result.kind !== "compile-waiting") {
    throw new Error("expected compile-waiting");
  }
  expect(result.state).toBe("WAITING_REPAIR_CONTEXT_CAPACITY");
  expect(result.dispatched).toBe(false);
  expect(result.nextState).toBe("REPAIR_PREPARING");
  expect(result.packet.requiredResponse).toBe("FULL_REPLACEMENT_CHANGESET");
});
