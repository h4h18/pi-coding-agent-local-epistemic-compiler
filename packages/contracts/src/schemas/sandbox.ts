import { Type, type Static } from "typebox";
import {
  DigestSchema,
  GeneralIdSchema,
  ObjectDigestSchema,
  OperationIdSchema,
  PositiveSafeUintSchema,
  ProjectIdSchema,
  RunIdSchema,
  SafeUintSchema,
  TimestampSchema,
  closed,
  utf8BoundedString,
  NormalizedPathSchema,
} from "../ids.js";
import { CommandSpecSchema, SourceRefSchema } from "./artifacts.js";

export const EnvironmentRecipeSchema = closed({
  schemaVersion: Type.Literal(1),
  platform: Type.Enum(["linux", "windows", "macos"] as const),
  architecture: utf8BoundedString(64),
  requiredCapabilities: Type.Array(utf8BoundedString(256)),
  source: Type.Enum([
    "run-override",
    "project-hec-config",
    "devcontainer",
    "nix",
    "project-native",
  ] as const),
  setupCommands: Type.Array(CommandSpecSchema),
  verificationCommands: Type.Array(CommandSpecSchema),
  networkPhases: Type.Array(
    closed({ phase: utf8BoundedString(64), destinations: Type.Array(utf8BoundedString(256)) }),
  ),
  writableRoots: Type.Array(NormalizedPathSchema),
  secretHandles: Type.Array(GeneralIdSchema),
  devices: Type.Array(utf8BoundedString(256)),
  resourceSafetyProfile: utf8BoundedString(256),
});

export const SandboxJobSchema = closed({
  schemaVersion: Type.Literal(1),
  projectId: ProjectIdSchema,
  runId: RunIdSchema,
  operationId: OperationIdSchema,
  leaseGeneration: SafeUintSchema,
  targetRunnerId: ProjectIdSchema,
  phase: Type.Enum(["SETUP", "BASELINE", "CANDIDATE", "ADDITIONAL_CHECK"] as const),
  resolvedCommandSpecObjectDigest: ObjectDigestSchema,
  approvalOrStandingPolicyObjectDigest: ObjectDigestSchema,
  inputTreeRootDigest: DigestSchema,
  environmentRecipeObjectDigest: ObjectDigestSchema,
  sandboxImageObjectDigest: ObjectDigestSchema,
  safetyProfileObjectDigest: ObjectDigestSchema,
  networkCapabilityObjectDigest: Type.Optional(ObjectDigestSchema),
  secretInjectionGrantObjectDigests: Type.Array(ObjectDigestSchema),
  outputPolicy: closed({
    stdoutBytes: PositiveSafeUintSchema,
    stderrBytes: PositiveSafeUintSchema,
    artifactBytes: PositiveSafeUintSchema,
    allowedArtifactGlobs: Type.Array(utf8BoundedString(1024)),
  }),
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  nonce: utf8BoundedString(128),
});

export const SandboxResourceUsageSchema = closed({
  cpuMillis: SafeUintSchema,
  peakMemoryBytes: SafeUintSchema,
  peakProcessCount: SafeUintSchema,
  writtenBytes: SafeUintSchema,
  networkSentBytes: SafeUintSchema,
  networkReceivedBytes: SafeUintSchema,
  wallClockMillis: SafeUintSchema,
});

export const SandboxJobResultSchema = Type.Union([
  closed({
    schemaVersion: Type.Literal(1),
    outcome: Type.Literal("COMPLETED"),
    projectId: ProjectIdSchema,
    runId: RunIdSchema,
    operationId: OperationIdSchema,
    leaseGeneration: SafeUintSchema,
    sandboxJobObjectDigest: ObjectDigestSchema,
    exitCode: Type.Integer({ minimum: -2147483648, maximum: 2147483647 }),
    termination: Type.Enum(["EXITED", "SIGNALLED", "SAFETY_LIMIT"] as const),
    stdoutObjectDigest: ObjectDigestSchema,
    stderrObjectDigest: ObjectDigestSchema,
    producedArtifactObjectDigests: Type.Array(ObjectDigestSchema),
    observedOutputTreeDigest: DigestSchema,
    resourceUsage: SandboxResourceUsageSchema,
    startedAt: TimestampSchema,
    completedAt: TimestampSchema,
  }),
  closed({
    schemaVersion: Type.Literal(1),
    outcome: Type.Literal("REJECTED"),
    projectId: ProjectIdSchema,
    runId: RunIdSchema,
    operationId: OperationIdSchema,
    leaseGeneration: SafeUintSchema,
    sandboxJobObjectDigest: ObjectDigestSchema,
    reasonCode: GeneralIdSchema,
    evidenceObjectDigest: ObjectDigestSchema,
    completedAt: TimestampSchema,
  }),
  closed({
    schemaVersion: Type.Literal(1),
    outcome: Type.Literal("OUTCOME_UNKNOWN"),
    projectId: ProjectIdSchema,
    runId: RunIdSchema,
    operationId: OperationIdSchema,
    leaseGeneration: SafeUintSchema,
    sandboxJobObjectDigest: ObjectDigestSchema,
    lastEvidenceObjectDigest: ObjectDigestSchema,
    completedAt: TimestampSchema,
  }),
]);

export const ProjectHecConfigSchema = closed({
  schemaVersion: Type.Literal(1),
  classification: Type.Optional(
    Type.Enum(["public", "internal", "confidential", "restricted"] as const),
  ),
  snapshot: Type.Optional(
    closed({
      includeGlobs: Type.Array(utf8BoundedString(1024)),
      excludeGlobs: Type.Array(utf8BoundedString(1024)),
      includeIgnoredGlobs: Type.Array(utf8BoundedString(1024)),
    }),
  ),
  instructionRoots: Type.Optional(Type.Array(utf8BoundedString(1024))),
  skillRoots: Type.Optional(Type.Array(utf8BoundedString(1024))),
  environment: Type.Optional(EnvironmentRecipeSchema),
  verification: Type.Optional(
    closed({
      requiredCommands: Type.Array(CommandSpecSchema),
      advisoryCommands: Type.Array(CommandSpecSchema),
      expectedArtifactGlobs: Type.Array(utf8BoundedString(1024)),
      generatedSourceGlobs: Type.Array(utf8BoundedString(1024)),
    }),
  ),
  externalDocumentation: Type.Optional(
    closed({
      permittedOrigins: Type.Array(utf8BoundedString(256)),
      versionSources: Type.Array(SourceRefSchema),
    }),
  ),
  requestedCapabilities: Type.Optional(Type.Array(utf8BoundedString(256))),
});

export const HostConfigSchema = closed({
  schemaVersion: Type.Literal(1),
  configRevision: SafeUintSchema,
  deploymentSecurityProfile: Type.Enum([
    "SINGLE_HOST",
    "SPLIT_CREDENTIALS",
    "SPLIT_CREDENTIALS_AND_VERIFIER",
  ] as const),
  control: closed({
    listenAddress: utf8BoundedString(256),
    databasePath: utf8BoundedString(4096),
    casRoot: utf8BoundedString(4096),
    indexRoot: utf8BoundedString(4096),
    tlsIdentityRef: utf8BoundedString(256),
    trustedClientCaRef: utf8BoundedString(256),
  }),
  independentServices: closed({
    credentialGatewayIdentity: Type.Optional(utf8BoundedString(256)),
    verifierAuthorityIdentity: Type.Optional(utf8BoundedString(256)),
    keyManagementIdentity: Type.Optional(utf8BoundedString(256)),
  }),
  localDeployments: Type.Array(
    closed({
      deploymentId: ProjectIdSchema,
      endpoint: utf8BoundedString(1024),
      modelRevision: GeneralIdSchema,
      profile: utf8BoundedString(256),
    }),
  ),
  cloudDeployments: Type.Array(
    closed({
      deploymentId: ProjectIdSchema,
      adapterId: GeneralIdSchema,
      endpoint: utf8BoundedString(1024),
      credentialRef: utf8BoundedString(256),
      priority: SafeUintSchema,
      retentionPolicyObjectDigest: ObjectDigestSchema,
    }),
  ),
  safetyProfiles: Type.Array(
    closed({
      id: GeneralIdSchema,
      cpuMillis: PositiveSafeUintSchema,
      memoryBytes: PositiveSafeUintSchema,
      processCount: PositiveSafeUintSchema,
      diskBytes: PositiveSafeUintSchema,
      wallClockMillis: PositiveSafeUintSchema,
      stdoutBytes: PositiveSafeUintSchema,
      stderrBytes: PositiveSafeUintSchema,
    }),
  ),
  retentionPolicyObjectDigest: ObjectDigestSchema,
  backupPolicyObjectDigest: ObjectDigestSchema,
});

export type EnvironmentRecipe = Static<typeof EnvironmentRecipeSchema>;
export type SandboxJob = Static<typeof SandboxJobSchema>;
export type SandboxJobResult = Static<typeof SandboxJobResultSchema>;
export type SandboxResourceUsage = Static<typeof SandboxResourceUsageSchema>;
export type ProjectHecConfig = Static<typeof ProjectHecConfigSchema>;
export type HostConfig = Static<typeof HostConfigSchema>;
