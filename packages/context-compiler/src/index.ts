import type { KeyObject } from "node:crypto";
import type {
  ArtifactEnvelope,
  CanonicalCloudRequest,
  CloudCallId,
  CloudRequestBinding,
  CompiledCloudConversation,
  ContextPacket,
  Digest,
  DomainDigest,
  EgressManifest,
  EvidenceBundle,
  EvidenceGraph,
  InstructionManifest,
  ObjectDigest,
  ProjectPolicy,
  RequirementLedger,
  RunId,
  SkillManifest,
  SnapshotId,
} from "@pi-hec/contracts";
import { taggedHash, canonicalizeRfc8785, objectDigestFromBytes, sha256Hex } from "@pi-hec/contracts";
import type { BlobStore } from "@pi-hec/cas";
import { asObjectDigest, compareUtf8 } from "@pi-hec/evidence";
import {
  buildEgressManifest,
  isPublicCloudExecutor,
  type DataClassification,
  type DlpFinding,
  type EgressPolicy,
} from "@pi-hec/security";
import {
  buildStableCachePrefix,
  cacheIdentityDigest,
  cacheIdentityFromParts,
  prefixContainsRunId,
  type CachePrefixParts,
} from "./cache-prefix.js";
import { selectBundles, type OmittedEvidence } from "./select.js";
import {
  CompilationFailure,
  assertPacketByteClosure,
  assertPacketClosure,
  buildContextPacket,
  collectSourceRefs,
  compileConversation,
  conversationBytes,
  envelopeDigestOf,
  inlinePayloadBody,
  redactPayloads,
  redactVerbatim,
  serializePacketSections,
  signArtifactEnvelope,
  sourcePathOf,
  toJsonValue,
  toolSchemasJson,
  unsignedEnvelope,
  type AuthoritativeInstructionBody,
  type InlinePayload,
  type LoadedSkill,
} from "./serialize.js";
import {
  TokenizerError,
  capacityStatesFor,
  countTokens,
  evaluateCapacity,
  estimateReservedOutput,
  type CapacityWaitingState,
  type CompilationPurpose,
} from "./tokenize.js";

export const packageName = "@pi-hec/context-compiler";

type CloudControlEnvelope = ContextPacket["control"];

export { selectBundles, isNeverOmitBundle, utilityOf, hierarchySortKey } from "./select.js";
export type { BundleSelection, OmissionReason, OmittedEvidence } from "./select.js";
export {
  SERIALIZATION_SECTION_TITLES,
  assertPacketByteClosure,
  assertPacketClosure,
  buildContextPacket,
  compileConversation,
  conversationBytes,
  envelopeDigestOf,
  inlinePayloadBody,
  objectDigestOf,
  serializePacketSections,
  signArtifactEnvelope,
  toJsonValue,
  unsignedEnvelope,
} from "./serialize.js";
export type { AuthoritativeInstructionBody, InlinePayload, LoadedSkill } from "./serialize.js";
export {
  CACHE_PREFIX_ORDER,
  buildStableCachePrefix,
  cacheIdentityDigest,
  cacheIdentityFromParts,
  prefixContainsRunId,
} from "./cache-prefix.js";
export type { CacheIdentityInput, CachePrefixPartId, CachePrefixParts } from "./cache-prefix.js";
export {
  KNOWN_TOKENIZER_REVISIONS,
  PI_HEC_TOKENIZER_REVISION,
  TokenizerError,
  capacityStatesFor,
  countTokens,
  estimateReservedOutput,
  evaluateCapacity,
} from "./tokenize.js";
export type {
  CapacityDecision,
  CapacityWaitingState,
  CompilationPurpose,
  ContextCapacityState,
  OutputCapacityState,
  OutputReserveInput,
} from "./tokenize.js";

export type EnvelopeSigner = {
  privateKey: KeyObject;
  keyId: string;
  certificateObjectDigest: ObjectDigest;
  signedAt: string;
};

export type QualifiedDeployment = {
  deploymentId: string;
  tokenizerRevision: string;
  contextLimitTokens: number;
  maxOutputTokens: number;
  adapterVersionObjectDigest: ObjectDigest;
  endpointIdentity: string;
  providerChain: readonly string[];
  modelRevision: string;
  retentionPolicyObjectDigest: ObjectDigest;
  region?: string;
};

export type CompilerInput = {
  purpose: CompilationPurpose;
  projectId: string;
  runId: RunId;
  cloudCallId: CloudCallId;
  snapshotId: SnapshotId;
  snapshotRootDigest: Digest;
  control: CloudControlEnvelope;
  requirementLedger: RequirementLedger;
  instructionManifest: InstructionManifest;
  skillManifest: SkillManifest;
  authoritativeInstructions: readonly AuthoritativeInstructionBody[];
  loadedSkills: readonly LoadedSkill[];
  graph: EvidenceGraph;
  bundles: readonly EvidenceBundle[];
  payloads: readonly InlinePayload[];
  verificationCapabilities: ContextPacket["verificationCapabilities"];
  deployment: QualifiedDeployment;
  policy: ProjectPolicy;
  explicitApproval: boolean;
  contractualRetention: boolean;
  noEgressCloudRoleAvailable: boolean;
  signer: EnvelopeSigner;
  expiresAt: string;
  historicalOutputTokens?: readonly number[];
  intendedPatchPaths?: readonly string[];
  expectedOperationTypes?: readonly string[];
  parentCloudCallId?: CloudCallId;
  contextDeltaObjectDigest?: ObjectDigest;
  repairPacketObjectDigest?: ObjectDigest;
  priorCandidateManifestObjectDigest?: ObjectDigest;
};

export type CompiledCloudArtifacts = {
  packet: ContextPacket;
  packetEnvelope: ArtifactEnvelope<ContextPacket>;
  requestBinding: CloudRequestBinding;
  requestBindingDigest: DomainDigest<"cloud-request-binding">;
  conversation: CompiledCloudConversation;
  conversationEnvelope: ArtifactEnvelope<CompiledCloudConversation>;
  egress: EgressManifest;
  egressEnvelope: ArtifactEnvelope<EgressManifest>;
  canonical: CanonicalCloudRequest;
  canonicalEnvelope: ArtifactEnvelope<CanonicalCloudRequest>;
  cachePrefix: string;
  cacheIdentity: ObjectDigest;
  omittedEvidence: readonly OmittedEvidence[];
};

export type CompilationOutcome =
  | { kind: "compiled"; artifacts: CompiledCloudArtifacts }
  | { kind: "waiting"; state: CapacityWaitingState | "WAITING_CLOUD_ELIGIBILITY"; reason: string }
  | { kind: "failed"; code: string; reason: string };

function signEnvelope<TPayload>(
  schemaName: string,
  payload: TPayload,
  signer: EnvelopeSigner,
): ArtifactEnvelope<TPayload> {
  return signArtifactEnvelope(
    schemaName,
    payload,
    signer.privateKey,
    signer.keyId,
    signer.certificateObjectDigest,
    signer.signedAt,
  );
}

function estimateBundleTokens(payloads: readonly InlinePayload[], tokenizerRevision: string) {
  return (bundle: EvidenceBundle): number => {
    let tokens = 8;
    for (const id of bundle.nodeIds) {
      const payload = payloads.find((item) => item.evidenceId === id);
      if (payload === undefined) {
        continue;
      }
      for (const source of payload.sources) {
        if (source.content.encoding === "utf-8") {
          tokens += countTokens(source.content.text, tokenizerRevision);
        } else {
          tokens += Math.ceil(source.content.base64.length / 4);
        }
      }
    }
    return tokens;
  };
}

function buildRequestBinding(input: {
  purpose: CompilationPurpose;
  runId: RunId;
  cloudCallId: CloudCallId;
  contextPacketObjectDigest: ObjectDigest;
  baseSnapshotId: SnapshotId;
  baseSnapshotRootDigest: Digest;
  deployment: QualifiedDeployment;
  resultSchemaObjectDigest: ObjectDigest;
  parentCloudCallId?: CloudCallId;
  contextDeltaObjectDigest?: ObjectDigest;
  repairPacketObjectDigest?: ObjectDigest;
  priorCandidateManifestObjectDigest?: ObjectDigest;
}): CloudRequestBinding {
  const shared = {
    schemaVersion: 1 as const,
    runId: input.runId,
    cloudCallId: input.cloudCallId,
    contextPacketObjectDigest: input.contextPacketObjectDigest,
    baseSnapshotId: input.baseSnapshotId,
    baseSnapshotRootDigest: input.baseSnapshotRootDigest,
    deploymentId: input.deployment.deploymentId,
    adapterVersionObjectDigest: input.deployment.adapterVersionObjectDigest,
    modelRevision: input.deployment.modelRevision,
    resultSchemaObjectDigest: input.resultSchemaObjectDigest,
  };
  switch (input.purpose) {
    case "initial":
      return { ...shared, purpose: "initial" };
    case "context-followup":
      if (input.parentCloudCallId === undefined || input.contextDeltaObjectDigest === undefined) {
        throw new CompilationFailure("BINDING", "context-followup binding is missing parent fields");
      }
      return {
        ...shared,
        purpose: "context-followup",
        parentCloudCallId: input.parentCloudCallId,
        contextDeltaObjectDigest: input.contextDeltaObjectDigest,
      };
    case "repair":
      if (
        input.parentCloudCallId === undefined ||
        input.repairPacketObjectDigest === undefined ||
        input.priorCandidateManifestObjectDigest === undefined
      ) {
        throw new CompilationFailure("BINDING", "repair binding is missing parent fields");
      }
      return {
        ...shared,
        purpose: "repair",
        parentCloudCallId: input.parentCloudCallId,
        repairPacketObjectDigest: input.repairPacketObjectDigest,
        priorCandidateManifestObjectDigest: input.priorCandidateManifestObjectDigest,
      };
    default: {
      const exhaustive: never = input.purpose;
      throw new CompilationFailure("BINDING", `unhandled purpose ${String(exhaustive)}`);
    }
  }
}

function buildCanonical(input: {
  binding: CloudRequestBinding;
  requestBindingDigest: DomainDigest<"cloud-request-binding">;
  egressManifestObjectDigest: ObjectDigest;
  compiledConversationObjectDigest: ObjectDigest;
  maxOutputTokens: number;
}): CanonicalCloudRequest {
  const binding = input.binding;
  const base = {
    schemaVersion: 1 as const,
    runId: binding.runId,
    cloudCallId: binding.cloudCallId,
    requestBindingDigest: input.requestBindingDigest,
    deploymentId: binding.deploymentId,
    adapterVersionObjectDigest: binding.adapterVersionObjectDigest,
    contextPacketObjectDigest: binding.contextPacketObjectDigest,
    egressManifestObjectDigest: input.egressManifestObjectDigest,
    compiledConversationObjectDigest: input.compiledConversationObjectDigest,
    resultMode: "terminal-tools" as const,
    maxOutputTokens: input.maxOutputTokens,
    reasoningProfile: "none",
    requestBinding: binding,
  };
  switch (binding.purpose) {
    case "initial":
      return { ...base, purpose: "initial", requestBinding: binding };
    case "context-followup":
      return {
        ...base,
        purpose: "context-followup",
        parentCloudCallId: binding.parentCloudCallId,
        contextDeltaObjectDigest: binding.contextDeltaObjectDigest,
        requestBinding: binding,
      };
    case "repair":
      return {
        ...base,
        purpose: "repair",
        parentCloudCallId: binding.parentCloudCallId,
        repairPacketObjectDigest: binding.repairPacketObjectDigest,
        priorCandidateManifestObjectDigest: binding.priorCandidateManifestObjectDigest,
        requestBinding: binding,
      };
    default: {
      const exhaustive: never = binding;
      throw new CompilationFailure("BINDING", `unhandled binding ${String(exhaustive)}`);
    }
  }
}

function cacheParts(packet: ContextPacket): CachePrefixParts {
  const tools = toolSchemasJson();
  return {
    controlProtocol: [
      "role=CLOUD_EXECUTOR",
      "allowedResultKinds=submit_solution,request_context",
      `forbidden=${packet.control.forbiddenCapabilities.join(",")}`,
      `resultSchema=${packet.control.resultSchemaObjectDigest}`,
    ].join("\n"),
    toolResultSchemas: JSON.stringify({ submit: tools.submit, request: tools.request }),
    platformPolicy: JSON.stringify(packet.control.userScope),
    effectiveInstructions: packet.authoritativeInstructions.map((item) => item.verbatimContent).join("\n"),
    mandatorySkills: packet.loadedSkills
      .filter((item) => item.descriptor.loadPolicy === "mandatory")
      .map((item) => item.verbatimContent)
      .join("\n"),
    repositoryManifests: JSON.stringify(packet.repositoryMap),
    taskSpecificEvidence: packet.evidencePayloads
      .map((item) => `${item.evidenceId}:${objectDigestFromBytes(Buffer.from(inlinePayloadBody(item), "utf8"))}`)
      .join("\n"),
  };
}

function egressPolicyOf(input: CompilerInput): EgressPolicy {
  return {
    projectClassification: input.policy.classification,
    permittedEgressClassifications: input.policy.permittedEgressClassifications,
    explicitApproval: input.explicitApproval,
    contractualRetention: input.contractualRetention,
    noEgressCloudRoleAvailable: input.noEgressCloudRoleAvailable,
  };
}

async function persistEnvelope(
  cas: BlobStore | undefined,
  projectId: string,
  schemaName: string,
  envelope: ArtifactEnvelope<unknown>,
  classification: "public" | "internal" | "confidential" | "restricted",
): Promise<void> {
  if (cas === undefined) {
    return;
  }
  await cas.putObject({
    projectId,
    bytes: Buffer.from(JSON.stringify(toJsonValue(envelope)), "utf8"),
    mediaType: "application/json",
    classification,
    schemaName,
  });
}

export function compileCloudContext(input: CompilerInput): CompilationOutcome {
  try {
    if (input.control.runId !== input.runId) {
      return { kind: "failed", code: "RUN_MISMATCH", reason: "control.runId does not match compiler runId" };
    }
    const tokenizerRevision = input.deployment.tokenizerRevision;
    countTokens("probe", tokenizerRevision);
    const redacted = redactPayloads(
      input.payloads,
      input.policy.classification,
      input.intendedPatchPaths ?? [],
    );
    if (redacted.kind === "rejected") {
      return { kind: "failed", code: redacted.code, reason: "intended patch depends on redacted bytes" };
    }
    const instructionFindings: DlpFinding[] = [];
    const redactedInstructions = input.authoritativeInstructions.map((item) => {
      const path = sourcePathOf(item.sourceRef);
      const result = redactVerbatim(item.verbatimContent, input.policy.classification, path);
      instructionFindings.push(...result.findings);
      return { ...item, verbatimContent: result.text, restricted: result.restricted };
    });
    const skillFindings: DlpFinding[] = [];
    const redactedSkills = input.loadedSkills.map((item) => {
      const path = sourcePathOf(item.descriptor.sourceRef);
      const result = redactVerbatim(item.verbatimContent, input.policy.classification, path);
      skillFindings.push(...result.findings);
      const contentDigest = sha256Hex(Buffer.from(result.text, "utf8"));
      return {
        skill: {
          ...item,
          verbatimContent: result.text,
          descriptor: { ...item.descriptor, contentDigest },
        },
        restricted: result.restricted,
      };
    });
    const dlpFindings = [...redacted.findings, ...instructionFindings, ...skillFindings];
    const restrictedContext =
      redacted.restricted ||
      redactedInstructions.some((item) => item.restricted) ||
      redactedSkills.some((item) => item.restricted);
    if (
      restrictedContext &&
      (!input.noEgressCloudRoleAvailable ||
        isPublicCloudExecutor({
          deploymentId: input.deployment.deploymentId,
          adapterVersionObjectDigest: input.deployment.adapterVersionObjectDigest,
          endpointIdentity: input.deployment.endpointIdentity,
          providerChain: input.deployment.providerChain,
          modelRevision: input.deployment.modelRevision,
          retentionPolicyObjectDigest: input.deployment.retentionPolicyObjectDigest,
        }))
    ) {
      return {
        kind: "waiting",
        state: "WAITING_CLOUD_ELIGIBILITY",
        reason: "restricted bytes in required executor context",
      };
    }
    const instructionManifest: InstructionManifest = {
      ...input.instructionManifest,
      instructions: input.instructionManifest.instructions.map((descriptor, index) => {
        const body = redactedInstructions[index];
        if (body === undefined) {
          return descriptor;
        }
        return { ...descriptor, contentDigest: sha256Hex(Buffer.from(body.verbatimContent, "utf8")) };
      }),
    };
    const skillManifest: SkillManifest = {
      ...input.skillManifest,
      skills: input.skillManifest.skills.map((descriptor) => {
        const loaded = redactedSkills.find((item) => item.skill.skillId === descriptor.id);
        if (loaded === undefined) {
          return descriptor;
        }
        return { ...descriptor, contentDigest: loaded.skill.descriptor.contentDigest };
      }),
    };
    const authoritativeInstructions = redactedInstructions.map((item) => ({
      scope: item.scope,
      precedence: item.precedence,
      sourceRef: item.sourceRef,
      verbatimContent: item.verbatimContent,
    }));
    const loadedSkills = redactedSkills.map((item) => item.skill);
    const fileCount = redacted.payloads.filter((item) => item.node.kind === "file").length;
    const interfaceCount = redacted.payloads.filter(
      (item) => item.node.kind === "api-contract" || item.node.kind === "schema" || item.node.kind === "symbol",
    ).length;
    const evidenceTokens = redacted.payloads.reduce((sum, item) => {
      return (
        sum +
        item.sources.reduce((inner, source) => {
          if (source.content.encoding !== "utf-8") {
            return inner;
          }
          return inner + countTokens(source.content.text, tokenizerRevision);
        }, 0)
      );
    }, 0);
    const reserved = estimateReservedOutput({
      purpose: input.purpose,
      requiredFileCount: Math.max(1, fileCount),
      requiredInterfaceCount: interfaceCount,
      expectedOperationTypes: input.expectedOperationTypes ?? input.control.allowedChangeOperations,
      fullReplacementRepair: input.purpose === "repair",
      schemaOverheadTokens: 2048,
      historicalOutputTokens: input.historicalOutputTokens ?? [],
      evidenceTokens,
    });
    const selectBudget = Math.max(1, input.deployment.contextLimitTokens - reserved);
    const selected = selectBundles({
      bundles: input.bundles,
      graph: input.graph,
      ledger: input.requirementLedger,
      tokenBudget: selectBudget,
      estimateBundleTokens: estimateBundleTokens(redacted.payloads, tokenizerRevision),
    });
    if (selected.kind === "capacity") {
      return {
        kind: "waiting",
        state: capacityStatesFor(input.purpose).context,
        reason: "mandatory material exceeds qualified context",
      };
    }
    const packet = buildContextPacket({
      runId: input.runId,
      snapshotId: input.snapshotId,
      snapshotRootDigest: input.snapshotRootDigest,
      control: input.control,
      requirementLedger: input.requirementLedger,
      instructionManifest,
      skillManifest,
      authoritativeInstructions,
      loadedSkills,
      graph: input.graph,
      bundles: selected.bundles,
      candidateBundles: input.bundles,
      payloads: redacted.payloads,
      verificationCapabilities: input.verificationCapabilities,
      omitted: selected.omitted,
      tokenization: {
        deploymentId: input.deployment.deploymentId,
        inputTokens: 0,
        reservedOutputTokens: reserved,
        tokenizerRevision,
      },
    });
    if (packet.omissionManifest.criticalOmissions.length > 0) {
      return { kind: "failed", code: "CRITICAL_OMISSION", reason: "criticalOmissions make dispatch invalid" };
    }
    const parts = cacheParts(packet);
    const cachePrefix = buildStableCachePrefix(parts);
    if (prefixContainsRunId(cachePrefix, input.runId)) {
      return { kind: "failed", code: "CACHE_PREFIX", reason: "runId leaked into stable cache prefix" };
    }
    const serialized = `${cachePrefix}\n${serializePacketSections(packet, true)}`;
    const inputTokens = countTokens(serialized, tokenizerRevision);
    const tokenized: ContextPacket = {
      ...packet,
      tokenization: {
        ...packet.tokenization,
        inputTokens,
      },
    };
    assertPacketClosure(tokenized, input.graph);
    assertPacketByteClosure(tokenized, input.graph);
    const capacity = evaluateCapacity({
      purpose: input.purpose,
      serializedInputTokens: inputTokens,
      reservedOutputTokens: reserved,
      contextLimitTokens: input.deployment.contextLimitTokens,
      maxOutputTokens: input.deployment.maxOutputTokens,
    });
    if (capacity.kind === "waiting") {
      return { kind: "waiting", state: capacity.state, reason: "qualified deployment lacks input or output capacity" };
    }
    const packetEnvelope = signEnvelope("ContextPacket", tokenized, input.signer);
    const packetObjectDigest = envelopeDigestOf(packetEnvelope);
    const requestBinding = buildRequestBinding({
      purpose: input.purpose,
      runId: input.runId,
      cloudCallId: input.cloudCallId,
      contextPacketObjectDigest: packetObjectDigest,
      baseSnapshotId: input.snapshotId,
      baseSnapshotRootDigest: input.snapshotRootDigest,
      deployment: input.deployment,
      resultSchemaObjectDigest: asObjectDigest(input.control.resultSchemaObjectDigest),
      ...(input.parentCloudCallId === undefined ? {} : { parentCloudCallId: input.parentCloudCallId }),
      ...(input.contextDeltaObjectDigest === undefined
        ? {}
        : { contextDeltaObjectDigest: input.contextDeltaObjectDigest }),
      ...(input.repairPacketObjectDigest === undefined
        ? {}
        : { repairPacketObjectDigest: input.repairPacketObjectDigest }),
      ...(input.priorCandidateManifestObjectDigest === undefined
        ? {}
        : { priorCandidateManifestObjectDigest: input.priorCandidateManifestObjectDigest }),
    });
    const requestBindingDigest = taggedHash("cloud-request-binding", 1, {
      requestBinding: toJsonValue(requestBinding),
    });
    const conversation = compileConversation({
      packet: tokenized,
      binding: requestBinding,
      requestBindingDigest,
      systemPrompt: cachePrefix.length > 0 ? cachePrefix : "cloud-executor",
    });
    const conversationEnvelope = unsignedEnvelope("CompiledCloudConversation", conversation);
    const conversationObjectDigest = envelopeDigestOf(conversationEnvelope);
    const egressOutcome = buildEgressManifest({
      runId: input.runId,
      snapshotId: input.snapshotId,
      contextPacketObjectDigest: packetObjectDigest,
      compiledConversationObjectDigest: conversationObjectDigest,
      conversationBytes: conversationBytes(conversation),
      sourceRefs: collectSourceRefs(tokenized),
      provider: {
        deploymentId: input.deployment.deploymentId,
        adapterVersionObjectDigest: input.deployment.adapterVersionObjectDigest,
        endpointIdentity: input.deployment.endpointIdentity,
        providerChain: input.deployment.providerChain,
        modelRevision: input.deployment.modelRevision,
        retentionPolicyObjectDigest: input.deployment.retentionPolicyObjectDigest,
        ...(input.deployment.region === undefined ? {} : { region: input.deployment.region }),
      },
      policy: egressPolicyOf(input),
      expiresAt: input.expiresAt,
      dlpFindings,
      ...(input.intendedPatchPaths === undefined ? {} : { intendedPatchPaths: input.intendedPatchPaths }),
    });
    if (egressOutcome.kind === "waiting") {
      return { kind: "waiting", state: egressOutcome.state, reason: egressOutcome.reason };
    }
    if (egressOutcome.kind === "rejected") {
      return { kind: "failed", code: egressOutcome.code, reason: egressOutcome.reason };
    }
    const egressEnvelope = unsignedEnvelope("EgressManifest", egressOutcome.manifest);
    const egressObjectDigest = envelopeDigestOf(egressEnvelope);
    const canonical = buildCanonical({
      binding: requestBinding,
      requestBindingDigest,
      egressManifestObjectDigest: egressObjectDigest,
      compiledConversationObjectDigest: conversationObjectDigest,
      maxOutputTokens: input.deployment.maxOutputTokens,
    });
    const canonicalEnvelope = signEnvelope("CanonicalCloudRequest", canonical, input.signer);
    const artifacts: CompiledCloudArtifacts = {
      packet: tokenized,
      packetEnvelope,
      requestBinding,
      requestBindingDigest,
      conversation,
      conversationEnvelope,
      egress: egressOutcome.manifest,
      egressEnvelope,
      canonical,
      canonicalEnvelope,
      cachePrefix,
      cacheIdentity: cacheIdentityDigest(cacheIdentityFromParts(input.projectId, parts)),
      omittedEvidence: selected.omitted,
    };
    return { kind: "compiled", artifacts };
  } catch (error) {
    if (error instanceof TokenizerError) {
      return { kind: "failed", code: error.code, reason: error.message };
    }
    if (error instanceof CompilationFailure) {
      return { kind: "failed", code: error.code, reason: error.message };
    }
    const message = error instanceof Error ? error.message : "compilation failed";
    return { kind: "failed", code: "COMPILE", reason: message };
  }
}

export async function persistCompiledCloudArtifacts(input: {
  cas: BlobStore;
  projectId: string;
  artifacts: CompiledCloudArtifacts;
}): Promise<void> {
  const classification = input.artifacts.egress.classification;
  await persistEnvelope(input.cas, input.projectId, "ContextPacket", input.artifacts.packetEnvelope, classification);
  await persistEnvelope(
    input.cas,
    input.projectId,
    "CompiledCloudConversation",
    input.artifacts.conversationEnvelope,
    classification,
  );
  await persistEnvelope(input.cas, input.projectId, "EgressManifest", input.artifacts.egressEnvelope, classification);
  await persistEnvelope(
    input.cas,
    input.projectId,
    "CanonicalCloudRequest",
    input.artifacts.canonicalEnvelope,
    classification,
  );
  const pairs = [...input.artifacts.omittedEvidence].sort((left, right) => {
    const byId = compareUtf8(left.evidenceId, right.evidenceId);
    if (byId !== 0) {
      return byId;
    }
    return compareUtf8(left.reason, right.reason);
  });
  await input.cas.putObject({
    projectId: input.projectId,
    bytes: Buffer.from(canonicalizeRfc8785({ pairs }), "utf8"),
    mediaType: "application/json",
    classification,
    schemaName: "OmissionRoot",
  });
}

export type { DataClassification, ProjectPolicy };
