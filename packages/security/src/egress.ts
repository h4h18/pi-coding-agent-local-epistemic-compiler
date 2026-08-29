import type {
  EgressManifest,
  ObjectDigest,
  RunId,
  SnapshotId,
  SourceRef,
} from "@pi-hec/contracts";
import {
  CLASSIFICATION_SCANNER_VERSION,
  maxClassification,
  type DataClassification,
} from "./classification.js";
import {
  DLP_SCANNER_VERSION,
  intendedPatchDependsOnRedacted,
  scanPathName,
  scanText,
  type DlpFinding,
  type DlpScanResult,
} from "./dlp.js";

export const EGRESS_SCANNER_VERSION = "pi-hec-egress/1.0.0";

export type EgressProviderChain = {
  deploymentId: string;
  adapterVersionObjectDigest: ObjectDigest;
  endpointIdentity: string;
  providerChain: readonly string[];
  modelRevision: string;
  region?: string;
  retentionPolicyObjectDigest: ObjectDigest;
};

export type EgressPolicy = {
  projectClassification: DataClassification;
  permittedEgressClassifications: readonly ("public" | "internal" | "confidential")[];
  explicitApproval: boolean;
  contractualRetention: boolean;
  noEgressCloudRoleAvailable: boolean;
};

export type EgressScanInput = {
  runId: RunId;
  snapshotId: SnapshotId;
  contextPacketObjectDigest: ObjectDigest;
  compiledConversationObjectDigest: ObjectDigest;
  conversationBytes: Uint8Array;
  sourceRefs: readonly SourceRef[];
  pathTexts?: Readonly<Record<string, string>>;
  provider: EgressProviderChain;
  policy: EgressPolicy;
  expiresAt: string;
  intendedPatchPaths?: readonly string[];
  dlpFindings?: readonly DlpFinding[];
};

export type EgressOutcome =
  | { kind: "manifest"; manifest: EgressManifest; findings: readonly DlpFinding[] }
  | {
      kind: "waiting";
      state: "WAITING_CLOUD_ELIGIBILITY";
      reason: string;
      findings: readonly DlpFinding[];
    }
  | { kind: "rejected"; code: "PATCH_DEPENDS_ON_REDACTED"; reason: string; findings: readonly DlpFinding[] };

function sourcePath(ref: SourceRef): string | undefined {
  if (ref.origin === "repository") {
    return ref.path;
  }
  if (ref.origin === "external") {
    return ref.url;
  }
  return undefined;
}

function conversationText(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

function dispatchableClassification(
  classification: DataClassification,
): "public" | "internal" | "confidential" | undefined {
  if (classification === "restricted") {
    return undefined;
  }
  return classification;
}

function policyAllows(
  classification: "public" | "internal" | "confidential",
  policy: EgressPolicy,
): boolean {
  if (!policy.permittedEgressClassifications.includes(classification)) {
    return false;
  }
  if (classification === "confidential") {
    return policy.explicitApproval && policy.contractualRetention;
  }
  return true;
}

export function scanExecutorContext(input: {
  conversationBytes: Uint8Array;
  sourceRefs: readonly SourceRef[];
  pathTexts?: Readonly<Record<string, string>>;
  projectClassification: DataClassification;
}): DlpScanResult {
  const scans: DlpScanResult[] = [
    scanText({
      text: conversationText(input.conversationBytes),
      projectClassification: input.projectClassification,
    }),
  ];
  for (const ref of input.sourceRefs) {
    const path = sourcePath(ref);
    if (path === undefined) {
      continue;
    }
    scans.push(scanPathName(path));
    const body = input.pathTexts?.[path];
    if (body !== undefined) {
      scans.push(
        scanText({
          text: body,
          path,
          projectClassification: input.projectClassification,
        }),
      );
    }
  }
  const findings = scans.flatMap((item) => [...item.findings]);
  return {
    classification: maxClassification([
      input.projectClassification,
      ...scans.map((item) => item.classification),
    ]),
    findings,
    redactedText: conversationText(input.conversationBytes),
    inspectable: scans.every((item) => item.inspectable),
  };
}

const PUBLIC_CLOUD_MARKERS = [
  "openai.com",
  "api.openai",
  "anthropic.com",
  "googleapis.com",
  "google.com",
  "azure.com",
  "openai.azure",
  "amazonaws.com",
  "aws.amazon",
  "together.xyz",
  "fireworks.ai",
  "groq.com",
  "x.ai",
  "openrouter.ai",
  "mistral.ai",
  "cohere.com",
] as const;

export function isPublicCloudExecutor(provider: EgressProviderChain): boolean {
  const haystack = `${provider.endpointIdentity}\n${provider.providerChain.join("\n")}`.toLowerCase();
  return PUBLIC_CLOUD_MARKERS.some((marker) => haystack.includes(marker));
}

function dispatchableFallback(policy: EgressPolicy): "public" | "internal" | "confidential" {
  if (policy.projectClassification !== "restricted") {
    return policy.projectClassification;
  }
  if (policy.permittedEgressClassifications.includes("confidential")) {
    return "confidential";
  }
  const first = policy.permittedEgressClassifications[0];
  return first ?? "internal";
}

export function buildEgressManifest(input: EgressScanInput): EgressOutcome {
  const scanned = scanExecutorContext({
    conversationBytes: input.conversationBytes,
    sourceRefs: input.sourceRefs,
    ...(input.pathTexts === undefined ? {} : { pathTexts: input.pathTexts }),
    projectClassification: input.policy.projectClassification,
  });
  if (intendedPatchDependsOnRedacted({
    findings: [...scanned.findings, ...(input.dlpFindings ?? [])],
    intendedPatchPaths: input.intendedPatchPaths ?? [],
  })) {
    return {
      kind: "rejected",
      code: "PATCH_DEPENDS_ON_REDACTED",
      reason: "intended patch depends on redacted bytes",
      findings: scanned.findings,
    };
  }
  if (scanned.classification === "restricted") {
    if (!input.policy.noEgressCloudRoleAvailable || isPublicCloudExecutor(input.provider)) {
      return {
        kind: "waiting",
        state: "WAITING_CLOUD_ELIGIBILITY",
        reason: "restricted bytes in required executor context",
        findings: scanned.findings,
      };
    }
  }
  const classification =
    scanned.classification === "restricted"
      ? dispatchableFallback(input.policy)
      : dispatchableClassification(scanned.classification);
  if (classification === undefined) {
    return {
      kind: "waiting",
      state: "WAITING_CLOUD_ELIGIBILITY",
      reason: "restricted bytes in required executor context",
      findings: scanned.findings,
    };
  }
  if (!policyAllows(classification, input.policy)) {
    return {
      kind: "waiting",
      state: "WAITING_CLOUD_ELIGIBILITY",
      reason: "egress classification is not permitted by standing policy",
      findings: scanned.findings,
    };
  }
  const redactionSource = input.dlpFindings ?? scanned.findings;
  const redactions = redactionSource
    .filter((finding) => finding.redactionPermitted)
    .map((finding) => {
      const ref = input.sourceRefs.find((item) => sourcePath(item) === finding.path);
      const sourceRef = ref ?? input.sourceRefs[0];
      if (sourceRef === undefined) {
        return undefined;
      }
      return {
        marker: finding.marker,
        findingType: finding.findingType,
        sourceRef,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined);
  const manifest: EgressManifest = {
    schemaVersion: 1,
    runId: input.runId,
    snapshotId: input.snapshotId,
    contextPacketObjectDigest: input.contextPacketObjectDigest,
    deploymentId: input.provider.deploymentId,
    adapterVersionObjectDigest: input.provider.adapterVersionObjectDigest,
    endpointIdentity: input.provider.endpointIdentity,
    providerChain: [...input.provider.providerChain],
    modelRevision: input.provider.modelRevision,
    retentionPolicyObjectDigest: input.provider.retentionPolicyObjectDigest,
    classification,
    sourceRefs: [...input.sourceRefs],
    redactions,
    scannerVersions: [
      CLASSIFICATION_SCANNER_VERSION,
      DLP_SCANNER_VERSION,
      EGRESS_SCANNER_VERSION,
    ],
    compiledConversationObjectDigest: input.compiledConversationObjectDigest,
    expiresAt: input.expiresAt,
    ...(input.provider.region === undefined ? {} : { region: input.provider.region }),
  };
  return { kind: "manifest", manifest, findings: scanned.findings };
}
