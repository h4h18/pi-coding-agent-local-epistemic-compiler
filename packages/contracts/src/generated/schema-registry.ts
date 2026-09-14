export type SchemaCompatibility = "additive" | "breaking" | "migration-required";

export type SchemaRegistryEntry = {
  schemaName: string;
  currentVersion: number;
  revisions: readonly {
    version: number;
    compatibility: SchemaCompatibility;
  }[];
};

export const SCHEMA_REGISTRY: readonly SchemaRegistryEntry[] = [
  "TaskEnvelope",
  "RequirementLedger",
  "SnapshotManifest",
  "GitHistoryManifest",
  "EvidenceGraph",
  "EvidenceBundle",
  "ContextPacket",
  "CloudResult",
  "ChangeSet",
  "CandidateManifest",
  "NoChangeReceipt",
  "SuccessfulRunResult",
  "VerdictReport",
  "EvidenceRecord",
  "InstructionManifest",
  "SkillManifest",
  "CompiledCloudConversation",
  "CanonicalCloudRequest",
  "ProviderWireRequest",
  "CloudCompletionReceipt",
  "EgressManifest",
  "EnvironmentSeal",
  "BaselineSeal",
  "BaselineSupplement",
  "VerificationPlan",
  "RepairPacket",
  "ApprovalSubject",
  "ApprovalDecision",
  "ApprovalGrant",
  "ApprovalChallenge",
  "ArtifactStorageRecord",
  "ApplyReceipt",
  "SandboxJob",
  "SandboxJobResult",
  "SecretInjectionGrant",
  "CommandSpec",
  "ResolvedCommandSpec",
  "ProjectPolicy",
  "ProjectHecConfig",
  "HostConfig",
  "UserInputArtifact",
  "CancellationReceipt",
  "RunDomainEvent",
  "RunTransitionEvent",
  "ExternalFetchReceipt",
  "CloudRequestBinding",
  "TaskContract",
  "InvestigationReport",
  "ImplementationPlan",
  "ChangeShards",
  "ChangeManifest",
  "ReviewFindings",
  "CommandEvidence",
  "AcceptanceLedger",
  "WorkflowProfile",
  "CompiledProfile",
  "RunComposition",
  "RelatedRunPlan",
  "SkillLock",
  "WorkspaceLease",
  "AgentSessionRecord",
  "CapabilityToken",
  "ReproductionUnavailable",
  "SpecUpdateNotRequired",
  "AgentNodeEvent",
  "ProjectAdapter",
  "RuntimeConfig",
  "WorkerArtifactEnvelope",
].map((schemaName) => {
  if (
    schemaName === "TaskContract" ||
    schemaName === "WorkflowProfile" ||
    schemaName === "CompiledProfile" ||
    schemaName === "RunComposition"
  ) {
    return {
      schemaName,
      currentVersion: 2,
      revisions: [
        { version: 1, compatibility: "additive" as const },
        { version: 2, compatibility: "additive" as const },
      ],
    };
  }
  return {
    schemaName,
    currentVersion: 1,
    revisions: [{ version: 1, compatibility: "additive" as const }],
  };
});

export class UnknownSchemaRevisionError extends Error {
  constructor(schemaName: string, schemaVersion: number) {
    super(`unknown schema revision ${schemaName}@${String(schemaVersion)}`);
    this.name = "UnknownSchemaRevisionError";
  }
}

export function assertKnownSchemaRevision(schemaName: string, schemaVersion: number): void {
  const entry = SCHEMA_REGISTRY.find((item) => item.schemaName === schemaName);
  if (entry === undefined) {
    throw new UnknownSchemaRevisionError(schemaName, schemaVersion);
  }
  if (!entry.revisions.some((revision) => revision.version === schemaVersion)) {
    throw new UnknownSchemaRevisionError(schemaName, schemaVersion);
  }
}

export function hasSchemaReader(schemaName: string, schemaVersion: number): boolean {
  const entry = SCHEMA_REGISTRY.find((item) => item.schemaName === schemaName);
  return (
    entry !== undefined && entry.revisions.some((revision) => revision.version === schemaVersion)
  );
}
