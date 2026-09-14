export type SignerRole = "admin" | "control" | "verifier" | "runner" | "broker" | "user";

export type SignerRegistryEntry = {
  schemaName: string;
  roles: readonly { role: SignerRole; count: number }[];
};

export const SIGNER_REGISTRY: readonly SignerRegistryEntry[] = [
  { schemaName: "ProjectPolicy", roles: [{ role: "admin", count: 1 }] },
  { schemaName: "ApprovalSubject", roles: [{ role: "control", count: 1 }] },
  { schemaName: "ApprovalChallenge", roles: [{ role: "control", count: 1 }] },
  { schemaName: "RequirementLedger", roles: [{ role: "control", count: 1 }] },
  { schemaName: "ContextPacket", roles: [{ role: "control", count: 1 }] },
  { schemaName: "VerificationPlan", roles: [{ role: "control", count: 1 }] },
  { schemaName: "CanonicalCloudRequest", roles: [{ role: "control", count: 1 }] },
  { schemaName: "CloudCompletionReceipt", roles: [{ role: "control", count: 1 }] },
  { schemaName: "CancellationReceipt", roles: [{ role: "control", count: 1 }] },
  { schemaName: "CandidateManifest", roles: [{ role: "verifier", count: 1 }] },
  { schemaName: "EvidenceGraph", roles: [{ role: "verifier", count: 1 }] },
  { schemaName: "EvidenceRecord", roles: [{ role: "verifier", count: 1 }] },
  { schemaName: "VerdictReport", roles: [{ role: "verifier", count: 1 }] },
  { schemaName: "NoChangeReceipt", roles: [{ role: "verifier", count: 1 }] },
  { schemaName: "SnapshotManifest", roles: [{ role: "runner", count: 1 }] },
  { schemaName: "ApplyReceipt", roles: [{ role: "runner", count: 1 }] },
  { schemaName: "SandboxJobResult", roles: [{ role: "runner", count: 1 }] },
  { schemaName: "ApprovalGrant", roles: [{ role: "broker", count: 1 }] },
  { schemaName: "ApprovalDecision", roles: [{ role: "user", count: 1 }] },
  { schemaName: "AcceptanceLedger", roles: [{ role: "control", count: 1 }] },
  { schemaName: "WorkflowProfile", roles: [{ role: "control", count: 1 }] },
  { schemaName: "CompiledProfile", roles: [{ role: "control", count: 1 }] },
  { schemaName: "RunComposition", roles: [{ role: "control", count: 1 }] },
  { schemaName: "RelatedRunPlan", roles: [{ role: "control", count: 1 }] },
  { schemaName: "SkillLock", roles: [{ role: "control", count: 1 }] },
  { schemaName: "ProjectAdapter", roles: [{ role: "control", count: 1 }] },
  { schemaName: "WorkspaceLease", roles: [{ role: "control", count: 1 }] },
  { schemaName: "CommandEvidence", roles: [{ role: "control", count: 1 }] },
];

const SIGNER_SCHEMA_SET: ReadonlySet<string> = new Set(
  SIGNER_REGISTRY.map((entry) => entry.schemaName),
);

export function isAuthoritySchema(schemaName: string): boolean {
  return SIGNER_SCHEMA_SET.has(schemaName);
}
