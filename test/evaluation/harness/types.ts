export const ARM_IDS = [1, 2, 3, 4] as const;

export type ArmId = (typeof ARM_IDS)[number];

export type ArmRole = "primary" | "diagnostic";

export type SliceTag =
  | "backend"
  | "frontend"
  | "mobile"
  | "systems"
  | "data"
  | "infrastructure"
  | "polyglot";

export type DatasetKind = "unknown-language-polyglot" | "adversarial-injection" | "undetermined-oracle";

export type LocalVerdict = "ACCEPTED" | "REJECTED" | "INCONCLUSIVE" | "DONE" | "FAILED";

export type ExternalLabel = "CORRECT" | "INCORRECT" | "UNDETERMINED";

export type TaskFixture = {
  readonly taskId: string;
  readonly dataset: DatasetKind;
  readonly repositoryId: string;
  readonly repositoryCommit: string;
  readonly snapshotId: string;
  readonly snapshotRootDigest: string;
  readonly sliceTags: readonly SliceTag[];
  readonly weight: number;
  readonly prompt: string;
  readonly goldPatchRef: string;
  readonly broken: boolean;
  readonly ambiguous: boolean;
  readonly noOracle: boolean;
};

export type FrozenEnvironment = {
  readonly environmentId: string;
  readonly deploymentId: string;
  readonly piVersion: "0.84.3";
  readonly temporalCutoff: string;
  readonly verifierImage: string;
  readonly prngSeed: number;
  readonly outputLimitTokens: number;
  readonly toolSchemaDigest: string;
  readonly promptRevision: string;
};

export type EligibilityDecision = {
  readonly taskId: string;
  readonly snapshotId: string;
  readonly eligible: boolean;
  readonly reason: "eligible" | "broken-snapshot" | "ambiguous-snapshot";
  readonly decidedBeforeReveal: true;
};

export type PairedTrial = {
  readonly taskId: string;
  readonly snapshotId: string;
  readonly deploymentId: string;
  readonly environmentId: string;
  readonly repositoryCommit: string;
  readonly eligibility: EligibilityDecision;
  readonly workspaces: Readonly<Record<ArmId, string>>;
};

export type LedgerCallRow = {
  readonly cloudCallId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly state: string;
  readonly createdAt: string;
};
