import type {
  AcceptanceLedger,
  CommandEvidence,
  ReviewFindings,
  TaskContract,
} from "@pi-hec/contracts";

export type CriterionEvidenceInput = {
  contract: TaskContract;
  contractRevision: number;
  integrationCommit: string;
  commandEvidence: readonly CommandEvidence[];
  reviewFindings: readonly ReviewFindings[];
  diffPaths: readonly string[];
  specUpdateSatisfied: boolean;
  blockingFindings: boolean;
  preExistingFailures: readonly string[];
};

export function compileAcceptanceLedger(input: CriterionEvidenceInput): AcceptanceLedger {
  const criteria = input.contract.acceptanceCriteria.map((criterion) => {
    const evidence: string[] = [];
    const needsCommand = criterion.requiredEvidence.includes("command");
    const needsDiff = criterion.requiredEvidence.includes("diff");
    const needsReview = criterion.requiredEvidence.includes("review");
    if (needsCommand) {
      const match = input.commandEvidence.find((item) => item.exitCode === 0);
      if (match !== undefined) {
        evidence.push(`cmd:${match.evidenceId}:${match.stdoutDigest}`);
      }
    }
    if (needsDiff && input.diffPaths.length > 0) {
      evidence.push(`diff:${input.integrationCommit}:${input.diffPaths[0] ?? ""}`);
    }
    if (needsReview) {
      const resolved = input.reviewFindings.every((report) => !report.blocking);
      if (resolved) {
        evidence.push("review:correctness:resolved");
      }
    }
    const proven =
      (!needsCommand || evidence.some((item) => item.startsWith("cmd:"))) &&
      (!needsDiff || evidence.some((item) => item.startsWith("diff:"))) &&
      (!needsReview || evidence.some((item) => item.startsWith("review:"))) &&
      !input.blockingFindings;
    return {
      id: criterion.id,
      status: proven ? ("proven" as const) : ("unproven" as const),
      evidence,
    };
  });
  const unproven = criteria.filter((item) => item.status !== "proven").map((item) => item.id);
  const closed =
    unproven.length === 0 &&
    !input.blockingFindings &&
    input.specUpdateSatisfied &&
    input.integrationCommit.length > 0;
  return {
    schemaVersion: 1,
    contractRevision: input.contractRevision,
    integrationCommit: input.integrationCommit,
    criteria,
    unproven,
    preExistingFailures: [...input.preExistingFailures],
    closed,
  };
}

export function definitionOfDoneSatisfied(input: {
  contractValid: boolean;
  ledger: AcceptanceLedger;
  integrationCommit: string;
  baselineCommit: string;
  outOfScopeChanges: boolean;
  gatesPassed: boolean;
  blockingFindings: boolean;
  freshReviewAfterRepair: boolean;
  specSatisfied: boolean;
  userTreeUntouched: boolean;
}): boolean {
  return (
    input.contractValid &&
    input.ledger.closed &&
    input.ledger.unproven.length === 0 &&
    input.integrationCommit.length > 0 &&
    input.baselineCommit.length > 0 &&
    !input.outOfScopeChanges &&
    input.gatesPassed &&
    !input.blockingFindings &&
    input.freshReviewAfterRepair &&
    input.specSatisfied &&
    input.userTreeUntouched
  );
}
