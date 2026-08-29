import { Type, type Static } from "typebox";
import {
  ApprovalIdSchema,
  Base64Schema,
  CandidateIdSchema,
  CloudCallIdSchema,
  DigestSchema,
  GeneralIdSchema,
  NormalizedPathSchema,
  ObjectDigestSchema,
  PositiveSafeUintSchema,
  ProjectIdSchema,
  ReasonSchema,
  RunIdSchema,
  SafeUintSchema,
  SnapshotIdSchema,
  TimestampSchema,
  closed,
  utf8BoundedString,
} from "../ids.js";

export const EvidenceDirectnessSchema = Type.Enum([
  "observed",
  "static-derived",
  "model-derived",
  "asserted",
] as const);

export const SourceRangeSchema = Type.Union([
  closed({ kind: Type.Literal("whole") }),
  Type.Refine(
    closed({
      kind: Type.Literal("bytes"),
      byteStart: SafeUintSchema,
      byteEnd: PositiveSafeUintSchema,
      displayLines: Type.Optional(
        closed({
          startLine: PositiveSafeUintSchema,
          endLine: PositiveSafeUintSchema,
        }),
      ),
    }),
    (value) => {
      if (!(value.byteStart < value.byteEnd)) {
        return false;
      }
      if (value.displayLines === undefined) {
        return true;
      }
      return value.displayLines.startLine <= value.displayLines.endLine;
    },
    () => "byte range must satisfy 0 <= start < end",
  ),
]);

export const RepositorySourceKindSchema = Type.Enum([
  "project-instruction",
  "repository",
  "git-history",
] as const);
export const ArtifactSourceKindSchema = Type.Enum([
  "user-task",
  "platform-policy",
  "runtime",
  "model-output",
] as const);

export const SourceRefSchema = Type.Union([
  closed({
    origin: Type.Literal("repository"),
    sourceKind: RepositorySourceKindSchema,
    snapshotId: SnapshotIdSchema,
    artifactObjectDigest: ObjectDigestSchema,
    path: NormalizedPathSchema,
    range: SourceRangeSchema,
    quoteDigest: DigestSchema,
  }),
  closed({
    origin: Type.Literal("artifact"),
    sourceKind: ArtifactSourceKindSchema,
    artifactObjectDigest: ObjectDigestSchema,
    range: SourceRangeSchema,
    quoteDigest: DigestSchema,
  }),
  closed({
    origin: Type.Literal("external"),
    sourceKind: Type.Literal("external-documentation"),
    fetchReceiptObjectDigest: ObjectDigestSchema,
    artifactObjectDigest: ObjectDigestSchema,
    url: utf8BoundedString(4096),
    range: SourceRangeSchema,
    quoteDigest: DigestSchema,
  }),
]);

export const ProvenanceSchema = closed({
  source: SourceRefSchema,
  extractorId: GeneralIdSchema,
  extractorVersion: GeneralIdSchema,
  queryId: Type.Optional(GeneralIdSchema),
  observedAt: TimestampSchema,
  contentDigest: DigestSchema,
});

export const TrustVectorSchema = closed({
  authority: Type.Number({ minimum: 0, maximum: 1 }),
  directness: EvidenceDirectnessSchema,
  extractorReliability: Type.Number({ minimum: 0, maximum: 1 }),
  freshness: Type.Number({ minimum: 0, maximum: 1 }),
  independenceGroup: GeneralIdSchema,
  adversarialRisk: Type.Number({ minimum: 0, maximum: 1 }),
});

export const GitFileModeSchema = Type.Enum(["100644", "100755"] as const);
export const ChildNameComparisonSchema = Type.Enum(["case-sensitive", "case-insensitive"] as const);

export const SnapshotPlatformMetadataSchema = Type.Union([
  closed({
    kind: Type.Literal("windows"),
    fileId: GeneralIdSchema,
    reparseTag: Type.Optional(SafeUintSchema),
    securityDescriptorDigest: DigestSchema,
    alternateStreams: Type.Array(
      closed({
        name: utf8BoundedString(1024),
        contentDigest: DigestSchema,
        byteSize: SafeUintSchema,
      }),
      { maxItems: 64 },
    ),
  }),
  closed({
    kind: Type.Literal("posix"),
    device: GeneralIdSchema,
    inode: GeneralIdSchema,
    mode: SafeUintSchema,
    ownerId: SafeUintSchema,
    groupId: SafeUintSchema,
    xattrsDigest: DigestSchema,
  }),
]);

const SnapshotEntryBase = {
  path: NormalizedPathSchema,
  platformMetadata: SnapshotPlatformMetadataSchema,
};

const SnapshotChunkSchema = closed({
  digest: ObjectDigestSchema,
  offset: SafeUintSchema,
  length: PositiveSafeUintSchema,
});

export const SnapshotEntrySchema = Type.Union([
  closed({
    ...SnapshotEntryBase,
    entryType: Type.Literal("file"),
    contentDigest: DigestSchema,
    size: SafeUintSchema,
    gitMode: GitFileModeSchema,
    gitObjectId: Type.Optional(GeneralIdSchema),
    storage: Type.Union([
      closed({ kind: Type.Literal("blob"), objectDigest: ObjectDigestSchema }),
      closed({
        kind: Type.Literal("chunks"),
        chunks: Type.Array(SnapshotChunkSchema, { minItems: 1 }),
      }),
    ]),
  }),
  closed({
    ...SnapshotEntryBase,
    entryType: Type.Literal("directory"),
    childNameComparison: ChildNameComparisonSchema,
  }),
  closed({
    ...SnapshotEntryBase,
    entryType: Type.Literal("symlink"),
    symlinkTarget: utf8BoundedString(32767),
    gitMode: Type.Literal("120000"),
  }),
  closed({
    ...SnapshotEntryBase,
    entryType: Type.Literal("submodule"),
    gitObjectId: GeneralIdSchema,
    gitMode: Type.Literal("160000"),
  }),
]);

export const ExcludedPathSchema = closed({
  path: Type.Union([
    closed({ kind: Type.Literal("normalized-path"), value: NormalizedPathSchema }),
    closed({ kind: Type.Literal("project-hmac"), value: utf8BoundedString(128) }),
  ]),
  reason: ReasonSchema,
  correctnessImpact: Type.Enum(["none", "possible", "blocking"] as const),
});

export const SnapshotManifestSchema = closed({
  schemaVersion: Type.Literal(1),
  snapshotId: SnapshotIdSchema,
  repositoryId: ProjectIdSchema,
  workspaceId: ProjectIdSchema,
  gitHead: Type.Optional(GeneralIdSchema),
  gitBranch: Type.Optional(utf8BoundedString(256)),
  gitIndexDigest: Type.Optional(DigestSchema),
  gitHistoryRootDigest: Type.Optional(DigestSchema),
  gitHistoryManifestObjectDigest: Type.Optional(ObjectDigestSchema),
  dirty: Type.Boolean(),
  filesystem: closed({
    platform: Type.Enum(["windows", "linux", "macos"] as const),
    rootChildNameComparison: ChildNameComparisonSchema,
    unicodeNormalization: Type.Enum(["NFC", "NFD", "none"] as const),
    unicodeSimpleFoldTableObjectDigest: ObjectDigestSchema,
    pathGlobDialect: Type.Literal("pi-hec-pathglob/v1"),
    volumeIdentity: GeneralIdSchema,
  }),
  entries: Type.Array(SnapshotEntrySchema),
  ignoredPathDigests: Type.Array(DigestSchema),
  excludedPaths: Type.Array(ExcludedPathSchema),
  rootDigest: DigestSchema,
  createdAt: TimestampSchema,
  runnerId: ProjectIdSchema,
});

export const GitHistoryManifestSchema = closed({
  schemaVersion: Type.Literal(1),
  repositoryId: ProjectIdSchema,
  snapshotId: SnapshotIdSchema,
  historyRootDigest: DigestSchema,
  refs: Type.Array(closed({ name: utf8BoundedString(256), targetObjectId: GeneralIdSchema })),
  commits: Type.Array(
    closed({
      objectId: GeneralIdSchema,
      parentObjectIds: Type.Array(GeneralIdSchema),
      authorTimestamp: TimestampSchema,
      committerTimestamp: TimestampSchema,
      messageDigest: DigestSchema,
      changedPaths: Type.Array(NormalizedPathSchema),
      patchArtifactObjectDigest: Type.Optional(ObjectDigestSchema),
    }),
  ),
  shallowBoundaryObjectIds: Type.Array(GeneralIdSchema),
  replaceRefsIgnored: Type.Literal(true),
});

export const ArtifactStorageRecordSchema = closed({
  schemaVersion: Type.Literal(1),
  projectId: ProjectIdSchema,
  objectDigest: ObjectDigestSchema,
  schemaName: Type.Optional(GeneralIdSchema),
  mediaType: utf8BoundedString(256),
  plaintextByteSize: SafeUintSchema,
  classification: Type.Enum(["public", "internal", "confidential", "restricted"] as const),
  encryptionAlgorithm: Type.Enum(["AES-256-GCM", "XCHACHA20-POLY1305"] as const),
  encryptionKeyId: GeneralIdSchema,
  encryptionNonceBase64: Base64Schema,
  createdAt: TimestampSchema,
});

export const CommandAuthoritySchema = Type.Enum([
  "USER_EXPLICIT",
  "VERIFIER_INTRINSIC",
  "PROJECT_CI",
  "PROJECT_INSTRUCTION",
  "PROJECT_MANIFEST",
  "CLOUD_PROPOSED",
] as const);

export const CommandSpecSchema = closed({
  schemaVersion: Type.Literal(1),
  id: GeneralIdSchema,
  authority: CommandAuthoritySchema,
  executable: utf8BoundedString(1024),
  argv: Type.Array(utf8BoundedString(4096), { maxItems: 256 }),
  workingDirectory: NormalizedPathSchema,
  environment: Type.Record(Type.String(), Type.String()),
  secretHandles: Type.Array(GeneralIdSchema, { maxItems: 32 }),
  network: Type.Enum(["NONE", "LOOPBACK", "DECLARED_ENDPOINTS"] as const),
  writableRoots: Type.Array(NormalizedPathSchema, { maxItems: 32 }),
  timeoutPolicy: Type.Enum(["PROJECT_DECLARED", "BASELINE_RELATIVE", "SAFETY_BOUND"] as const),
  sourceRefs: Type.Array(SourceRefSchema),
});

export const ResolvedCommandSpecSchema = closed({
  schemaVersion: Type.Literal(1),
  sourceCommandObjectDigest: ObjectDigestSchema,
  executablePath: utf8BoundedString(4096),
  executableDigest: DigestSchema,
  argv: Type.Array(utf8BoundedString(4096), { maxItems: 256 }),
  workingDirectory: NormalizedPathSchema,
  environment: Type.Record(Type.String(), Type.String()),
  secretHandles: Type.Array(GeneralIdSchema, { maxItems: 32 }),
  networkDestinations: Type.Array(utf8BoundedString(256), { maxItems: 64 }),
  readOnlyMounts: Type.Array(NormalizedPathSchema, { maxItems: 64 }),
  writableRoots: Type.Array(NormalizedPathSchema, { maxItems: 32 }),
  sandboxImageObjectDigest: ObjectDigestSchema,
  safetyProfileObjectDigest: ObjectDigestSchema,
});

export const InstructionDescriptorSchema = closed({
  id: GeneralIdSchema,
  scope: utf8BoundedString(1024),
  precedence: SafeUintSchema,
  trust: Type.Enum(["platform", "user", "trusted-project", "untrusted-data"] as const),
  sourceRef: SourceRefSchema,
  contentDigest: DigestSchema,
});

export const InstructionManifestSchema = closed({
  schemaVersion: Type.Literal(1),
  snapshotId: SnapshotIdSchema,
  instructions: Type.Array(InstructionDescriptorSchema),
});

export const SkillDescriptorSchema = closed({
  id: GeneralIdSchema,
  name: utf8BoundedString(256),
  description: utf8BoundedString(16384),
  sourceRef: SourceRefSchema,
  scope: utf8BoundedString(1024),
  contentDigest: DigestSchema,
  loadPolicy: Type.Enum(["mandatory", "applicable", "on-request"] as const),
  executableAssets: Type.Array(SourceRefSchema),
});

export const SkillManifestSchema = closed({
  schemaVersion: Type.Literal(1),
  snapshotId: SnapshotIdSchema,
  skills: Type.Array(SkillDescriptorSchema),
  conflicts: Type.Array(
    closed({
      skillIds: Type.Array(GeneralIdSchema, { minItems: 1 }),
      sourceRefs: Type.Array(SourceRefSchema),
      reason: ReasonSchema,
    }),
  ),
});

export const ApplyReceiptBaseSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  approvalId: ApprovalIdSchema,
  workspaceId: ProjectIdSchema,
  candidateManifestObjectDigest: ObjectDigestSchema,
  baseSnapshotRootDigest: DigestSchema,
  changeSetObjectDigest: ObjectDigestSchema,
  journalObjectDigest: ObjectDigestSchema,
  promotionMode: Type.Enum(["ENTRY_JOURNALED", "ROOT_SWAP"] as const),
  affectedPaths: Type.Array(
    closed({
      path: NormalizedPathSchema,
      beforeDigest: Type.Union([DigestSchema, Type.Null()]),
      expectedAfterDigest: Type.Union([DigestSchema, Type.Null()]),
      observedAfterDigest: Type.Union([DigestSchema, Type.Null()]),
    }),
  ),
  completedAt: TimestampSchema,
});

export const ApplyReceiptSchema = Type.Union([
  Type.Object(
    {
      ...ApplyReceiptBaseSchema.properties,
      outcome: Type.Literal("COMMITTED"),
      resultingRootDigest: DigestSchema,
      visibilityGuarantee: Type.Enum(["ENTRY_LEVEL", "ATOMIC_ROOT_SWITCH"] as const),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ApplyReceiptBaseSchema.properties,
      outcome: Type.Literal("ROLLED_BACK"),
      restoredRootDigest: DigestSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ApplyReceiptBaseSchema.properties,
      outcome: Type.Literal("STALE"),
      observedWorkspaceRootDigest: DigestSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ApplyReceiptBaseSchema.properties,
      outcome: Type.Literal("MANUAL_RECOVERY_REQUIRED"),
      observedWorkspaceRootDigest: DigestSchema,
      recoveryEvidenceObjectDigest: ObjectDigestSchema,
    },
    { additionalProperties: false },
  ),
]);

export const CandidateManifestSchema = closed({
  schemaVersion: Type.Literal(1),
  candidateId: CandidateIdSchema,
  runId: RunIdSchema,
  sourceCloudCallId: CloudCallIdSchema,
  sourceCloudResultObjectDigest: ObjectDigestSchema,
  requestEnvelopeObjectDigest: ObjectDigestSchema,
  changeSetObjectDigest: ObjectDigestSchema,
  baseSnapshotId: SnapshotIdSchema,
  baseSnapshotRootDigest: DigestSchema,
  materializedTreeDigest: DigestSchema,
  changedPaths: Type.Array(NormalizedPathSchema),
  materializerVersionObjectDigest: ObjectDigestSchema,
  createdAt: TimestampSchema,
});

export const NoChangeReceiptSchema = closed({
  schemaVersion: Type.Literal(1),
  runId: RunIdSchema,
  cloudCallId: CloudCallIdSchema,
  cloudResultObjectDigest: ObjectDigestSchema,
  requestEnvelopeObjectDigest: ObjectDigestSchema,
  contextPacketObjectDigest: ObjectDigestSchema,
  requirementLedgerObjectDigest: ObjectDigestSchema,
  baselineSealObjectDigest: ObjectDigestSchema,
  verdictReportObjectDigest: ObjectDigestSchema,
  snapshotId: SnapshotIdSchema,
  snapshotRootDigest: DigestSchema,
  completedAt: TimestampSchema,
});

export const SuccessfulRunResultSchema = Type.Union([
  closed({
    schemaVersion: Type.Literal(1),
    runId: RunIdSchema,
    kind: Type.Literal("applied"),
    candidateManifestObjectDigest: ObjectDigestSchema,
    applyReceiptObjectDigest: ObjectDigestSchema,
    resultingSnapshotRootDigest: DigestSchema,
  }),
  closed({
    schemaVersion: Type.Literal(1),
    runId: RunIdSchema,
    kind: Type.Literal("no_change"),
    noChangeReceiptObjectDigest: ObjectDigestSchema,
    unchangedSnapshotRootDigest: DigestSchema,
  }),
]);

export const ExternalFetchReceiptSchema = closed({
  schemaVersion: Type.Literal(1),
  requestedUrl: utf8BoundedString(4096),
  finalUrl: utf8BoundedString(4096),
  redirects: Type.Array(
    closed({
      status: Type.Enum([301, 302, 303, 307, 308] as const),
      from: utf8BoundedString(4096),
      to: utf8BoundedString(4096),
      resolvedPublicAddresses: Type.Array(utf8BoundedString(64)),
      connectedAddress: utf8BoundedString(64),
      tlsPeerSpkiSha256: DigestSchema,
      responseHeaders: Type.Array(
        closed({ nameLowercase: utf8BoundedString(256), value: utf8BoundedString(4096) }),
      ),
    }),
  ),
  fetchedAt: TimestampSchema,
  status: SafeUintSchema,
  resolvedPublicAddresses: Type.Array(utf8BoundedString(64)),
  connectedAddress: utf8BoundedString(64),
  tlsPeerSpkiSha256: DigestSchema,
  responseHeaders: Type.Array(
    closed({ nameLowercase: utf8BoundedString(256), value: utf8BoundedString(4096) }),
  ),
  wireByteSize: SafeUintSchema,
  decodedByteSize: SafeUintSchema,
  mediaType: utf8BoundedString(256),
  rawContentObjectDigest: ObjectDigestSchema,
  sanitizedContentObjectDigest: ObjectDigestSchema,
  sanitizerVersionObjectDigest: ObjectDigestSchema,
  declaredDependencyVersion: Type.Optional(utf8BoundedString(256)),
  observedDocumentationVersion: Type.Optional(utf8BoundedString(256)),
});

export const EnvelopeBytesContentSchema = Type.Union([
  closed({ encoding: Type.Literal("utf-8"), text: Type.String({ minLength: 1 }) }),
  closed({ encoding: Type.Literal("base64"), base64: Base64Schema }),
]);

export type SourceRange = Static<typeof SourceRangeSchema>;
export type SourceRef = Static<typeof SourceRefSchema>;
export type Provenance = Static<typeof ProvenanceSchema>;
export type TrustVector = Static<typeof TrustVectorSchema>;
export type SnapshotManifest = Static<typeof SnapshotManifestSchema>;
export type SnapshotEntry = Static<typeof SnapshotEntrySchema>;
export type GitHistoryManifest = Static<typeof GitHistoryManifestSchema>;
export type ArtifactStorageRecord = Static<typeof ArtifactStorageRecordSchema>;
export type CommandSpec = Static<typeof CommandSpecSchema>;
export type ResolvedCommandSpec = Static<typeof ResolvedCommandSpecSchema>;
export type InstructionManifest = Static<typeof InstructionManifestSchema>;
export type SkillDescriptor = Static<typeof SkillDescriptorSchema>;
export type SkillManifest = Static<typeof SkillManifestSchema>;
export type ApplyReceipt = Static<typeof ApplyReceiptSchema>;
export type CandidateManifest = Static<typeof CandidateManifestSchema>;
export type NoChangeReceipt = Static<typeof NoChangeReceiptSchema>;
export type SuccessfulRunResult = Static<typeof SuccessfulRunResultSchema>;
export type ExternalFetchReceipt = Static<typeof ExternalFetchReceiptSchema>;
