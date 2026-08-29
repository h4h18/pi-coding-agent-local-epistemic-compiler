import { Type, type Static } from "typebox";
import {
  ApprovalIdSchema,
  CloudCallIdSchema,
  DigestSchema,
  GeneralIdSchema,
  ObjectDigestSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  TimestampSchema,
  closed,
  utf8BoundedString,
} from "../ids.js";

export const ApprovalActionSchema = Type.Enum([
  "cloud-egress",
  "command",
  "workspace-promotion",
  "project-trust",
  "project-policy",
  "workspace-registration",
] as const);

export const ApprovalSubjectSchema = Type.Union([
  closed({
    schemaVersion: Type.Literal(1),
    kind: Type.Literal("cloud-egress"),
    runId: RunIdSchema,
    cloudCallId: CloudCallIdSchema,
    baseSnapshotRootDigest: DigestSchema,
    contextPacketObjectDigest: ObjectDigestSchema,
    compiledConversationObjectDigest: ObjectDigestSchema,
    egressManifestObjectDigest: ObjectDigestSchema,
    canonicalCloudRequestObjectDigest: ObjectDigestSchema,
    providerWireRequestObjectDigest: ObjectDigestSchema,
    deploymentId: ProjectIdSchema,
    adapterVersionObjectDigest: ObjectDigestSchema,
    endpointIdentity: utf8BoundedString(1024),
    modelRevision: GeneralIdSchema,
    retentionPolicyObjectDigest: ObjectDigestSchema,
  }),
  closed({
    schemaVersion: Type.Literal(1),
    kind: Type.Literal("command"),
    runId: RunIdSchema,
    phase: Type.Enum(["BASELINE", "CANDIDATE", "ADDITIONAL"] as const),
    resolvedCommandSpecObjectDigest: ObjectDigestSchema,
    environmentSealObjectDigest: ObjectDigestSchema,
    sandboxPolicyObjectDigest: ObjectDigestSchema,
    inputTreeRootDigest: DigestSchema,
  }),
  closed({
    schemaVersion: Type.Literal(1),
    kind: Type.Literal("workspace-promotion"),
    runId: RunIdSchema,
    candidateManifestObjectDigest: ObjectDigestSchema,
    verdictReportObjectDigest: ObjectDigestSchema,
    baseSnapshotRootDigest: DigestSchema,
    currentWorkspaceRootDigest: DigestSchema,
    runnerId: ProjectIdSchema,
    promotionMode: Type.Enum(["ENTRY_JOURNALED", "ROOT_SWAP"] as const),
  }),
  closed({
    schemaVersion: Type.Literal(1),
    kind: Type.Literal("project-trust"),
    projectId: ProjectIdSchema,
    proposedPolicyObjectDigest: ObjectDigestSchema,
    classification: Type.Enum(["public", "internal", "confidential", "restricted"] as const),
    enrollingPrincipalId: GeneralIdSchema,
    requestedTrust: Type.Enum(["trusted", "revoked"] as const),
  }),
  closed({
    schemaVersion: Type.Literal(1),
    kind: Type.Literal("workspace-registration"),
    projectId: ProjectIdSchema,
    workspaceId: ProjectIdSchema,
    runnerId: ProjectIdSchema,
    rootFingerprint: utf8BoundedString(256),
    platform: Type.Enum(["windows", "linux", "macos"] as const),
    brokerAttestationObjectDigest: ObjectDigestSchema,
  }),
  closed({
    schemaVersion: Type.Literal(1),
    kind: Type.Literal("project-policy"),
    projectId: ProjectIdSchema,
    priorPolicyObjectDigest: ObjectDigestSchema,
    proposedPolicyObjectDigest: ObjectDigestSchema,
  }),
]);

export const ApprovalDecisionSchema = closed({
  schemaVersion: Type.Literal(1),
  approvalId: ApprovalIdSchema,
  projectId: ProjectIdSchema,
  principalId: GeneralIdSchema,
  challengeObjectDigest: ObjectDigestSchema,
  subjectObjectDigest: ObjectDigestSchema,
  policyObjectDigest: ObjectDigestSchema,
  displayArtifactObjectDigest: ObjectDigestSchema,
  nonce: utf8BoundedString(128),
  decision: Type.Enum(["APPROVE", "DENY"] as const),
  decidedAt: TimestampSchema,
  expiresAt: TimestampSchema,
});

const ApprovalGrantBaseFields = {
  schemaVersion: Type.Literal(1),
  approvalId: ApprovalIdSchema,
  projectId: ProjectIdSchema,
  principalId: GeneralIdSchema,
  challengeObjectDigest: ObjectDigestSchema,
  approvalDecisionObjectDigest: ObjectDigestSchema,
  subjectObjectDigest: ObjectDigestSchema,
  policyObjectDigest: ObjectDigestSchema,
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
};

export const ApprovalGrantSchema = Type.Union([
  closed({
    ...ApprovalGrantBaseFields,
    scope: Type.Literal("run"),
    runId: RunIdSchema,
    action: Type.Enum(["cloud-egress", "command", "workspace-promotion"] as const),
  }),
  closed({
    ...ApprovalGrantBaseFields,
    scope: Type.Literal("project"),
    action: Type.Enum(["project-trust", "project-policy", "workspace-registration"] as const),
  }),
]);

export const SecretInjectionGrantSchema = closed({
  schemaVersion: Type.Literal(1),
  grantId: GeneralIdSchema,
  projectId: ProjectIdSchema,
  runId: RunIdSchema,
  operationId: OperationIdSchema,
  secretHandle: GeneralIdSchema,
  targetRunnerId: ProjectIdSchema,
  targetProcessDigest: DigestSchema,
  destination: Type.Union([
    closed({ kind: Type.Literal("environment"), name: utf8BoundedString(256) }),
    closed({
      kind: Type.Literal("file"),
      relativePath: utf8BoundedString(1024),
      mode: Type.Literal("0400"),
    }),
  ]),
  permittedNetworkDestinations: Type.Array(utf8BoundedString(256)),
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  nonce: utf8BoundedString(128),
});

export type ApprovalSubject = Static<typeof ApprovalSubjectSchema>;
export type ApprovalDecision = Static<typeof ApprovalDecisionSchema>;
export type ApprovalGrant = Static<typeof ApprovalGrantSchema>;
export type SecretInjectionGrant = Static<typeof SecretInjectionGrantSchema>;
