import { expect, test } from "vitest";
import {
  LocalSemanticFindingSchema,
  SemanticVerificationResultSchema,
  asEvidenceId,
  type LocalSemanticFinding,
  type SemanticVerificationResult,
} from "@pi-hec/contracts";
import { Compile } from "typebox/compile";
import { openEvidenceObligationsFromReview, scheduleEvidenceFromFindings } from "../../src/semantic-review.js";
import { ANALYST_PROSE, CANDIDATE, OBJECT, REQ, RUN, SNAP, jsonContains, repoRef } from "./helpers.js";

const FINDING = Compile(LocalSemanticFindingSchema);
const RESULT = Compile(SemanticVerificationResultSchema);
const CLAIM = asEvidenceId("evidence_" + "a".repeat(52));

function finding(overrides: Partial<LocalSemanticFinding> = {}): LocalSemanticFinding {
  const value: LocalSemanticFinding = {
    id: "finding-widget",
    kind: "ROOT_CAUSE_HYPOTHESIS",
    statement: ANALYST_PROSE,
    sourceRefs: [repoRef("src/widget.ts")],
    requirementIds: [REQ],
    confidence: "HIGH",
    ...overrides,
  };
  expect(FINDING.Check(value)).toBe(true);
  return value;
}

function review(findings: readonly LocalSemanticFinding[]): SemanticVerificationResult {
  const value: SemanticVerificationResult = {
    schemaVersion: 1,
    candidateId: CANDIDATE,
    candidateManifestObjectDigest: OBJECT,
    findings: [...findings],
  };
  expect(RESULT.Check(value)).toBe(true);
  return value;
}

test("local finding statements never appear in scheduled obligation text or retrieval intents", () => {
  const scheduled = scheduleEvidenceFromFindings({
    runId: RUN,
    snapshotId: SNAP,
    findings: [finding()],
    authoritativeClaimIds: [CLAIM],
  });
  expect(scheduled.intents.length).toBeGreaterThan(0);
  expect(scheduled.actions.length).toBeGreaterThan(0);
  expect(scheduled.obligations.length).toBeGreaterThan(0);
  expect(jsonContains(scheduled, ANALYST_PROSE)).toBe(false);
  for (const obligation of scheduled.obligations) {
    expect(obligation.claim.includes(ANALYST_PROSE)).toBe(false);
    expect(obligation.sourceRefs).toEqual([repoRef("src/widget.ts")]);
    expect(obligation.requirementIds).toEqual([REQ]);
  }
  for (const intent of scheduled.intents) {
    expect(intent.entityHints).toContain("src/widget.ts");
    expect(intent.claimIds).toEqual([CLAIM]);
  }
  for (const action of scheduled.actions) {
    expect(action.query).toBe("src/widget.ts");
    expect(action.targetClaimIds).toEqual([CLAIM]);
  }
});

test("reviewCandidateAgainstEvidence output only opens evidence obligations and cannot adjudicate", () => {
  const result = openEvidenceObligationsFromReview({
    review: review([finding({ kind: "MISSING_EVIDENCE" })]),
    runId: RUN,
    snapshotId: SNAP,
    authoritativeClaimIds: [CLAIM],
  });
  expect("verdict" in result).toBe(false);
  expect("pass" in result).toBe(false);
  expect("fail" in result).toBe(false);
  expect("repairGuidance" in result).toBe(false);
  expect(jsonContains(result, ANALYST_PROSE)).toBe(false);
  expect(result.obligations.length).toBeGreaterThan(0);
  expect(result.intents[0]?.claimIds).toEqual([CLAIM]);
});

test("findings without source refs do not mint obligations from statement text", () => {
  const scheduled = scheduleEvidenceFromFindings({
    runId: RUN,
    snapshotId: SNAP,
    findings: [finding({ sourceRefs: [], statement: ANALYST_PROSE })],
    authoritativeClaimIds: [CLAIM],
  });
  expect(scheduled.obligations).toEqual([]);
  expect(jsonContains(scheduled, ANALYST_PROSE)).toBe(false);
});

const EVIDENCE_SEARCH_CHANNELS = ["lexical", "structural", "history", "tests", "instructions"] as const;

test("scheduled actions and intents only use canonical evidence_search channels and pathPrefix", () => {
  const kinds: readonly LocalSemanticFinding["kind"][] = [
    "AMBIGUITY",
    "CONTRADICTION",
    "RISK",
    "ROOT_CAUSE_HYPOTHESIS",
    "SEMANTIC_MISMATCH",
    "MISSING_EVIDENCE",
  ];
  const expectedChannel: Record<LocalSemanticFinding["kind"], (typeof EVIDENCE_SEARCH_CHANNELS)[number]> = {
    AMBIGUITY: "instructions",
    CONTRADICTION: "tests",
    RISK: "tests",
    ROOT_CAUSE_HYPOTHESIS: "structural",
    SEMANTIC_MISMATCH: "structural",
    MISSING_EVIDENCE: "lexical",
  };
  for (const kind of kinds) {
    const scheduled = scheduleEvidenceFromFindings({
      runId: RUN,
      snapshotId: SNAP,
      findings: [finding({ id: `finding-${kind}`, kind })],
      authoritativeClaimIds: [CLAIM],
    });
    expect(scheduled.actions.length).toBeGreaterThan(0);
    for (const action of scheduled.actions) {
      expect(EVIDENCE_SEARCH_CHANNELS).toContain(action.channelId);
      expect(action.channelId).toBe(expectedChannel[kind]);
      expect(action.filters).toEqual({ pathPrefix: "src/widget.ts" });
      expect(Object.hasOwn(action.filters, "path")).toBe(false);
    }
    const serialized = JSON.stringify(scheduled);
    expect(serialized.includes("git-history")).toBe(false);
    expect(serialized.includes('"ast"')).toBe(false);
    expect(serialized.includes('"bm25"')).toBe(false);
  }
});
