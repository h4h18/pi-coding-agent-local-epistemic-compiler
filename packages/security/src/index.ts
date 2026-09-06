export const packageName = "@pi-hec/security";

export {
  CompositeIdentityStore,
  StaticIdentityStore,
  constructPrincipalScope,
  mapCertificateToScope,
  normalizeSerial,
  parsePeerCertificate,
  spkiSha256FromCertificateDer,
  spkiSha256FromKey,
} from "./identity.js";
export type {
  CertificatePrincipalRecord,
  IdentityKind,
  IdentityMappingResult,
  IdentityStorePort,
  PeerCertificateInput,
  ProjectGrantRecord,
} from "./identity.js";

export { authorizeOperation, isOwningRunnerAudience } from "./authorization.js";
export type { AuthorizationDecision } from "./authorization.js";

export { mintCapability, verifyCapability } from "./capability.js";
export type {
  CapabilityPurpose,
  CapabilityToken,
  CapabilityVerifyResult,
  SignedCapability,
} from "./capability.js";

export {
  MAX_CREATED_SKEW_SECONDS,
  MAX_LIFETIME_SECONDS,
  MUTATION_PROFILE_TAG,
  NonceCache,
  SIGNATURE_LABEL,
  buildSignatureBase,
  contentDigestSha256,
  generateNonce,
  mutationHeaders,
  parseSignature,
  parseSignatureInput,
  serializeSignature,
  serializeSignatureInput,
  signMutation,
  verifyMutation,
} from "./replay.js";
export type {
  CoveredComponent,
  MutationMessage,
  SignatureParams,
  VerifyMutationResult,
} from "./replay.js";

export {
  CLASSIFICATION_SCANNER_VERSION,
  DATA_CLASSIFICATIONS,
  PERMITTED_FINDING_TYPES,
  RESTRICTED_FINDING_TYPES,
  classifyContent,
  classifyPathName,
  classifyText,
  classificationRank,
  collapseSpans,
  isRestrictedFindingType,
  luhnValid,
  maxClassification,
  scanSensitiveSpans,
} from "./classification.js";
export type {
  DataClassification,
  PermittedFindingType,
  RestrictedFindingType,
  SensitiveFindingType,
  SensitiveSpan,
} from "./classification.js";

export {
  DLP_SCANNER_VERSION,
  applyPermittedRedactions,
  intendedPatchDependsOnRedacted,
  mergeDlpResults,
  scanPathName,
  scanSourceContent,
  scanText,
  stableRedactionMarker,
} from "./dlp.js";
export type { DlpFinding, DlpScanResult } from "./dlp.js";

export {
  EGRESS_SCANNER_VERSION,
  buildEgressManifest,
  isPublicCloudExecutor,
  scanExecutorContext,
} from "./egress.js";
export type {
  EgressOutcome,
  EgressPolicy,
  EgressProviderChain,
  EgressScanInput,
} from "./egress.js";

export {
  ApprovalError,
  ApprovalNonceRegistry,
  GrantConsumptionRegistry,
  approvalObjectDigest,
  consumeGrant,
  freshApprovalNonce,
  grantBindingForSubject,
  platformUserPresence,
  signApprovalDecision,
  verifyDecisionAndIssueGrant,
} from "./approval.js";
export { issueGrantIfFaActive } from "./fa-grant.js";
export type { FaIdentityLookup } from "./approval.js";
export type {
  ApprovalChallenge,
  ApprovalDigestSchema,
  GrantBinding,
  ProjectGrantBinding,
  RunGrantBinding,
  SignedApprovalDecision,
  SignedApprovalGrant,
  UserPresence,
  UserPresenceProof,
} from "./approval.js";
