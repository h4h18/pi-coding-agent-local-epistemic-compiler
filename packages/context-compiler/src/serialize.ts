import { sign as cryptoSign, type KeyObject } from "node:crypto";
import { Compile } from "typebox/compile";
import {
  ContextPacketSchema,
  RequestContextToolParametersSchema,
  SubmitSolutionToolParametersSchema,
  canonicalizeRfc8785,
  envelopeObjectDigest,
  objectDigestFromBytes,
  payloadDigest,
  sha256Hex,
  signatureInputDigest,
  taggedHash,
  type ArtifactEnvelope,
  type CloudRequestBinding,
  type CompiledCloudConversation,
  type ContextPacket,
  type EvidenceBundle,
  type EvidenceEdge,
  type EvidenceGraph,
  type EvidenceId,
  type EvidenceNode,
  type InstructionManifest,
  type JsonValue,
  type ObjectDigest,
  type RequirementLedger,
  type SkillManifest,
  type SourceRef,
} from "@pi-hec/contracts";
import { asEvidenceId, compareUtf8 } from "@pi-hec/evidence";
import { scanSourceContent, scanText, type DataClassification, type DlpFinding } from "@pi-hec/security";
import type { OmittedEvidence } from "./select.js";
import { hierarchySortKey, isNeverOmitBundle } from "./select.js";

const PACKET = Compile(ContextPacketSchema);
const SOURCES_MIN_PATH = /^\/evidencePayloads\/\d+\/sources$/u;

function packetSchemaErrors(packet: unknown): { path: string; message: string }[] {
  if (PACKET.Check(packet)) {
    return [];
  }
  return PACKET.Errors(packet)
    .filter((error) => !(error.message === "must not have fewer than 2 items" && SOURCES_MIN_PATH.test(error.instancePath)))
    .map((error) => ({ path: error.instancePath, message: error.message }));
}

export const SERIALIZATION_SECTION_TITLES = [
  "1. Control envelope",
  "2. Original task and normative requirements",
  "3. Effective instructions and mandatory skills",
  "4. Most critical causal bundles",
  "5. Repository map",
  "6. Exact code/test/config evidence",
  "7. Runtime/history/external docs",
  "8. Evidence-backed conflicts and unknowns",
  "9. Verification capabilities",
  "10. Compact evidence/omission manifest",
  "11. Repeat terminal output contract",
] as const;

export class CompilationFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CompilationFailure";
    this.code = code;
  }
}

export type AuthoritativeInstructionBody = {
  scope: string;
  precedence: number;
  sourceRef: SourceRef;
  verbatimContent: string;
};

export type LoadedSkill = {
  skillId: string;
  descriptor: SkillManifest["skills"][number];
  verbatimContent: string;
};

export type InlinePayload = ContextPacket["evidencePayloads"][number];
type CloudControlEnvelope = ContextPacket["control"];

const STRUCTURAL_KINDS = new Set([
  "directory",
  "file",
  "symbol",
  "code-region",
  "requirement",
  "task",
  "constraint",
  "invariant",
]);

const CODE_KINDS = new Set(["file", "symbol", "code-region", "test", "build-config", "schema", "api-contract"]);
const RUNTIME_KINDS = new Set([
  "test-result",
  "coverage-region",
  "stack-frame",
  "commit",
  "diff-hunk",
  "runtime-observation",
  "external-documentation",
]);

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalizeRfc8785(value)) as JsonValue;
}

export function jsonSchemaOf(schema: unknown): JsonValue {
  return JSON.parse(JSON.stringify(schema)) as JsonValue;
}

export function objectDigestOf(value: unknown): ObjectDigest {
  return objectDigestFromBytes(Buffer.from(canonicalizeRfc8785(value), "utf8"));
}

export function signArtifactEnvelope<TPayload>(
  schemaName: string,
  payload: TPayload,
  privateKey: KeyObject,
  keyId: string,
  certDigest: ObjectDigest,
  signedAt: string,
): ArtifactEnvelope<TPayload> {
  const json = toJsonValue(payload);
  const digest = payloadDigest({ schemaName, schemaVersion: 1, payload: json });
  const input = signatureInputDigest({
    schemaName,
    schemaVersion: 1,
    payloadDigest: digest,
    keyId,
    algorithm: "Ed25519",
    signedAt,
    signerCertificateObjectDigest: certDigest,
  });
  const signatureBytes = cryptoSign(null, Buffer.from(input, "utf8"), privateKey);
  return {
    schemaName,
    schemaVersion: 1,
    payload,
    payloadDigest: digest,
    signatures: [
      {
        keyId,
        algorithm: "Ed25519",
        signedAt,
        signerCertificateObjectDigest: certDigest,
        signature: signatureBytes.toString("base64"),
      },
    ],
  };
}

export function envelopeDigestOf<TPayload>(envelope: ArtifactEnvelope<TPayload>): ObjectDigest {
  return envelopeObjectDigest({
    schemaName: envelope.schemaName,
    schemaVersion: envelope.schemaVersion,
    payload: toJsonValue(envelope.payload),
    payloadDigest: envelope.payloadDigest,
    signatures: envelope.signatures,
  });
}

export function unsignedEnvelope<TPayload>(schemaName: string, payload: TPayload): ArtifactEnvelope<TPayload> {
  return {
    schemaName,
    schemaVersion: 1,
    payload,
    payloadDigest: payloadDigest({ schemaName, schemaVersion: 1, payload: toJsonValue(payload) }),
    signatures: [],
  };
}

function isDigestOnlyText(text: string): boolean {
  return /^sha256:[0-9a-f]{64}$/u.test(text.trim());
}

function payloadBody(payload: InlinePayload): string {
  const chunks: string[] = [];
  for (const source of payload.sources) {
    if (source.content.encoding === "utf-8") {
      chunks.push(source.content.text);
    } else {
      chunks.push(Buffer.from(source.content.base64, "base64").toString("utf8"));
    }
  }
  return chunks.join("\n");
}

export function inlinePayloadBody(payload: InlinePayload): string {
  return payloadBody(payload);
}

function assertIndependentlyReproduced(payload: InlinePayload): void {
  assertNotLocalModel(payload.node);
  if (STRUCTURAL_KINDS.has(payload.node.kind)) {
    return;
  }
  if (payload.node.provenance.length === 0) {
    throw new CompilationFailure("CLOSURE", `evidence ${payload.evidenceId} missing provenance`);
  }
  if (payload.node.trust.directness === "model-derived") {
    throw new CompilationFailure("CLOSURE", `evidence ${payload.evidenceId} is not independently reproduced`);
  }
}

function assertNotLocalModel(node: EvidenceNode): void {
  if (node.authorship === "LOCAL_MODEL" || node.authorship === "CLOUD_MODEL") {
    throw new CompilationFailure("LOCAL_MODEL_PROSE", `local-model node ${node.id} cannot enter ContextPacket`);
  }
}

export function assertInlineBody(payload: InlinePayload): void {
  const body = payloadBody(payload);
  if (body.length === 0) {
    throw new CompilationFailure("DIGEST_ONLY", `evidence ${payload.evidenceId} is missing an inline body`);
  }
  for (const source of payload.sources) {
    if (source.content.encoding === "utf-8" && isDigestOnlyText(source.content.text)) {
      throw new CompilationFailure("DIGEST_ONLY", `evidence ${payload.evidenceId} is digest-only`);
    }
  }
  if (isDigestOnlyText(body)) {
    throw new CompilationFailure("DIGEST_ONLY", `evidence ${payload.evidenceId} is digest-only`);
  }
}

function skillContentDigest(content: string): ReturnType<typeof sha256Hex> {
  return sha256Hex(Buffer.from(content, "utf8"));
}

export function omissionRootDigest(pairs: readonly OmittedEvidence[]): ContextPacket["omissionManifest"]["omittedEvidenceRootDigest"] {
  const sorted = [...pairs].sort((left, right) => {
    const byId = compareUtf8(left.evidenceId, right.evidenceId);
    if (byId !== 0) {
      return byId;
    }
    return compareUtf8(left.reason, right.reason);
  });
  return taggedHash("omission-root", 1, {
    pairs: sorted.map((item) => ({ evidenceId: item.evidenceId, reason: item.reason })),
  });
}

export type PacketBuildInput = {
  runId: ContextPacket["runId"];
  snapshotId: ContextPacket["snapshotId"];
  snapshotRootDigest: ContextPacket["snapshotRootDigest"];
  control: CloudControlEnvelope;
  requirementLedger: RequirementLedger;
  instructionManifest: InstructionManifest;
  skillManifest: SkillManifest;
  authoritativeInstructions: readonly AuthoritativeInstructionBody[];
  loadedSkills: readonly LoadedSkill[];
  graph: EvidenceGraph;
  bundles: readonly EvidenceBundle[];
  candidateBundles?: readonly EvidenceBundle[];
  payloads: readonly InlinePayload[];
  verificationCapabilities: ContextPacket["verificationCapabilities"];
  omitted: readonly OmittedEvidence[];
  tokenization: ContextPacket["tokenization"];
};

function nodeById(graph: EvidenceGraph): Map<string, EvidenceNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function edgeById(graph: EvidenceGraph): Map<string, EvidenceEdge> {
  return new Map(graph.edges.map((edge) => [edge.id, edge]));
}

function pathOf(node: EvidenceNode): string {
  const identity = node.identityKey;
  const parts = identity.split(":");
  return parts[1] ?? node.label;
}

export function buildRepositoryMap(
  graph: EvidenceGraph,
  bundles: readonly EvidenceBundle[],
  relations: readonly EvidenceEdge[],
): ContextPacket["repositoryMap"] {
  const selected = new Set(bundles.flatMap((bundle) => [...bundle.nodeIds]));
  const nodes = graph.nodes
    .filter((node) => selected.has(node.id) && (node.kind === "directory" || node.kind === "file" || node.kind === "symbol"))
    .sort(
      (left, right) =>
        compareUtf8(hierarchySortKey(left), hierarchySortKey(right)) || compareUtf8(pathOf(left), pathOf(right)),
    );
  const byPath = new Map<string, { path: string; kind: string; symbols: string[]; relationIds: string[] }>();
  for (const node of nodes) {
    const path = pathOf(node);
    const existing = byPath.get(path);
    const symbols = node.kind === "symbol" ? [node.label] : [];
    const relationIds = relations
      .filter((edge) => edge.from === node.id || edge.to === node.id)
      .map((edge) => edge.id);
    if (existing === undefined) {
      byPath.set(path, {
        path,
        kind: node.kind,
        symbols,
        relationIds,
      });
    } else {
      existing.symbols.push(...symbols);
      existing.relationIds.push(...relationIds);
    }
  }
  return [...byPath.values()].map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    symbols: [...new Set(entry.symbols)].sort(compareUtf8),
    relationIds: [...new Set(entry.relationIds)].sort(compareUtf8),
  }));
}

function classifyFactLists(
  graph: EvidenceGraph,
  selectedIds: ReadonlySet<string>,
): Pick<ContextPacket, "verifiedFacts" | "unknowns" | "conflicts" | "risks"> {
  const verifiedFacts: EvidenceId[] = [];
  const unknowns: EvidenceId[] = [];
  const conflicts: EvidenceId[] = [];
  const risks: EvidenceId[] = [];
  for (const node of graph.nodes) {
    if (!selectedIds.has(node.id)) {
      continue;
    }
    if (node.authorship === "LOCAL_MODEL" || node.authorship === "CLOUD_MODEL") {
      continue;
    }
    if (node.kind === "unknown" || node.status === "unknown") {
      unknowns.push(asEvidenceId(node.id));
    } else if (node.kind === "conflict" || node.status === "conflicted") {
      conflicts.push(asEvidenceId(node.id));
    } else if (node.kind === "risk") {
      risks.push(asEvidenceId(node.id));
    } else if (node.status === "verified" && (node.kind === "fact" || node.kind === "constraint" || node.kind === "invariant")) {
      verifiedFacts.push(asEvidenceId(node.id));
    }
  }
  verifiedFacts.sort(compareUtf8);
  unknowns.sort(compareUtf8);
  conflicts.sort(compareUtf8);
  risks.sort(compareUtf8);
  return { verifiedFacts, unknowns, conflicts, risks };
}

export function assertPacketClosure(packet: ContextPacket, graph: EvidenceGraph): void {
  const details = packetSchemaErrors(packet);
  if (details.length > 0) {
    throw new CompilationFailure("PACKET_SCHEMA", `ContextPacket failed schema validation ${JSON.stringify(details.slice(0, 8))}`);
  }
  const payloadById = new Map(packet.evidencePayloads.map((item) => [item.evidenceId, item]));
  if (payloadById.size !== packet.evidencePayloads.length) {
    throw new CompilationFailure("CLOSURE", "duplicate evidence payload id");
  }
  const relationById = new Map(packet.relations.map((item) => [item.id, item]));
  if (relationById.size !== packet.relations.length) {
    throw new CompilationFailure("CLOSURE", "duplicate relation id");
  }
  for (const bundle of packet.bundles) {
    for (const nodeId of bundle.nodeIds) {
      const payload = payloadById.get(nodeId);
      if (payload === undefined) {
        throw new CompilationFailure("CLOSURE", `bundle ${bundle.id} missing payload ${nodeId}`);
      }
      assertInlineBody(payload);
      assertIndependentlyReproduced(payload);
    }
    for (const edgeId of bundle.edgeIds) {
      if (!relationById.has(edgeId)) {
        throw new CompilationFailure("CLOSURE", `bundle ${bundle.id} missing relation ${edgeId}`);
      }
    }
  }
  for (const id of [...packet.verifiedFacts, ...packet.unknowns, ...packet.conflicts, ...packet.risks]) {
    const payload = payloadById.get(id);
    if (payload === undefined) {
      throw new CompilationFailure("CLOSURE", `fact list missing payload ${id}`);
    }
    assertInlineBody(payload);
    assertIndependentlyReproduced(payload);
  }
  for (const entry of packet.repositoryMap) {
    for (const relationId of entry.relationIds) {
      if (!relationById.has(relationId)) {
        throw new CompilationFailure("CLOSURE", `repositoryMap missing relation ${relationId}`);
      }
    }
  }
  const instructions = packet.instructionManifest.instructions;
  if (instructions.length !== packet.authoritativeInstructions.length) {
    throw new CompilationFailure("CLOSURE", "authoritative instruction mapping is not 1:1");
  }
  for (let index = 0; index < instructions.length; index += 1) {
    const descriptor = instructions[index];
    const body = packet.authoritativeInstructions[index];
    if (descriptor === undefined || body === undefined) {
      throw new CompilationFailure("CLOSURE", "authoritative instruction mapping is not 1:1");
    }
    if (descriptor.scope !== body.scope || descriptor.precedence !== body.precedence) {
      throw new CompilationFailure("CLOSURE", "authoritative instruction descriptor mismatch");
    }
    if (skillContentDigest(body.verbatimContent) !== descriptor.contentDigest) {
      throw new CompilationFailure("CLOSURE", "authoritative instruction content digest mismatch");
    }
  }
  const loadedById = new Map(packet.loadedSkills.map((item) => [item.skillId, item]));
  for (const descriptor of packet.skillManifest.skills) {
    if (descriptor.loadPolicy !== "mandatory") {
      continue;
    }
    const loaded = loadedById.get(descriptor.id);
    if (loaded === undefined) {
      throw new CompilationFailure("DIGEST_ONLY", `mandatory skill ${descriptor.id} is missing an inline body`);
    }
    if (isDigestOnlyText(loaded.verbatimContent)) {
      throw new CompilationFailure("DIGEST_ONLY", `skill ${descriptor.id} is digest-only`);
    }
    if (skillContentDigest(loaded.verbatimContent) !== descriptor.contentDigest) {
      throw new CompilationFailure("CLOSURE", `skill ${descriptor.id} body digest mismatch`);
    }
  }
  for (const loaded of packet.loadedSkills) {
    if (skillContentDigest(loaded.verbatimContent) !== loaded.descriptor.contentDigest) {
      throw new CompilationFailure("CLOSURE", `loaded skill ${loaded.skillId} digest mismatch`);
    }
  }
  if (packet.requirementLedger.originalRequest.length === 0) {
    throw new CompilationFailure("CLOSURE", "requirement ledger missing original request");
  }
  const graphNodes = nodeById(graph);
  for (const payload of packet.evidencePayloads) {
    const graphNode = graphNodes.get(payload.evidenceId);
    if (graphNode !== undefined && graphNode.authorship === "LOCAL_MODEL") {
      throw new CompilationFailure("LOCAL_MODEL_PROSE", `local-model node ${payload.evidenceId} leaked into packet`);
    }
  }
}

export function assertPacketByteClosure(packet: ContextPacket, graph: EvidenceGraph): void {
  const image: unknown = JSON.parse(canonicalizeRfc8785(packet));
  if (image === null || typeof image !== "object" || packetSchemaErrors(image).length > 0) {
    throw new CompilationFailure("PACKET_SCHEMA", "serialized ContextPacket failed byte-image validation");
  }
  assertPacketClosure(image as ContextPacket, graph);
}

function criticalOmissionEntries(
  omitted: readonly OmittedEvidence[],
  bundles: readonly EvidenceBundle[],
  graph: EvidenceGraph,
): ContextPacket["omissionManifest"]["criticalOmissions"] {
  const criticalIds = new Set(
    bundles.filter((bundle) => isNeverOmitBundle(bundle, graph)).flatMap((bundle) => [...bundle.nodeIds]),
  );
  const entries: ContextPacket["omissionManifest"]["criticalOmissions"] = [];
  for (const item of omitted) {
    if (!criticalIds.has(item.evidenceId)) {
      continue;
    }
    if (item.reason === "untrusted" || item.reason === "window-capacity") {
      entries.push({ evidenceId: item.evidenceId, reason: item.reason });
    }
  }
  return entries.sort((left, right) => compareUtf8(left.evidenceId, right.evidenceId));
}

export function buildContextPacket(input: PacketBuildInput): ContextPacket {
  const selectedIds = new Set(input.bundles.flatMap((bundle) => [...bundle.nodeIds]));
  const edges = edgeById(input.graph);
  const relations: EvidenceEdge[] = [];
  const relationSeen = new Set<string>();
  for (const bundle of input.bundles) {
    for (const edgeId of bundle.edgeIds) {
      const edge = edges.get(edgeId);
      if (edge === undefined) {
        throw new CompilationFailure("CLOSURE", `unresolved edge ${edgeId}`);
      }
      if (!relationSeen.has(edge.id)) {
        relationSeen.add(edge.id);
        relations.push(edge);
      }
    }
  }
  relations.sort((left, right) => compareUtf8(left.id, right.id));
  const payloads = input.payloads.filter((item) => {
    if (!selectedIds.has(item.evidenceId)) {
      return false;
    }
    assertNotLocalModel(item.node);
    assertInlineBody(item);
    return true;
  });
  const facts = classifyFactLists(input.graph, selectedIds);
  const extraIds = [...facts.verifiedFacts, ...facts.unknowns, ...facts.conflicts, ...facts.risks];
  const payloadById = new Map(payloads.map((item) => [item.evidenceId, item]));
  for (const id of extraIds) {
    if (payloadById.has(id)) {
      continue;
    }
    const extra = input.payloads.find((item) => item.evidenceId === id);
    if (extra === undefined) {
      throw new CompilationFailure("CLOSURE", `missing payload for ${id}`);
    }
    assertNotLocalModel(extra.node);
    assertInlineBody(extra);
    payloads.push(extra);
    payloadById.set(id, extra);
  }
  payloads.sort((left, right) => {
    const byHierarchy = compareUtf8(hierarchySortKey(left.node), hierarchySortKey(right.node));
    if (byHierarchy !== 0) {
      return byHierarchy;
    }
    return compareUtf8(left.evidenceId, right.evidenceId);
  });
  const countsByReason = {
    duplicate: 0,
    "lower-utility": 0,
    untrusted: 0,
    "window-capacity": 0,
  };
  for (const item of input.omitted) {
    countsByReason[item.reason] += 1;
  }
  const packet: ContextPacket = {
    schemaVersion: 1,
    runId: input.runId,
    snapshotId: input.snapshotId,
    snapshotRootDigest: input.snapshotRootDigest,
    requirementLedgerObjectDigest: objectDigestOf(input.requirementLedger),
    instructionManifestObjectDigest: objectDigestOf(input.instructionManifest),
    skillManifestObjectDigest: objectDigestOf(input.skillManifest),
    control: input.control,
    requirementLedger: input.requirementLedger,
    instructionManifest: input.instructionManifest,
    skillManifest: input.skillManifest,
    authoritativeInstructions: [...input.authoritativeInstructions],
    repositoryMap: buildRepositoryMap(input.graph, input.bundles, relations),
    bundles: [...input.bundles],
    relations,
    evidencePayloads: payloads,
    loadedSkills: [...input.loadedSkills],
    verifiedFacts: facts.verifiedFacts,
    unknowns: facts.unknowns,
    conflicts: facts.conflicts,
    risks: facts.risks,
    verificationCapabilities: [...input.verificationCapabilities],
    omissionManifest: {
      omittedEvidenceRootDigest: omissionRootDigest(input.omitted),
      countsByReason,
      criticalOmissions: criticalOmissionEntries(
        input.omitted,
        input.candidateBundles ?? input.bundles,
        input.graph,
      ),
    },
    tokenization: input.tokenization,
  };
  assertPacketClosure(packet, input.graph);
  assertPacketByteClosure(packet, input.graph);
  return packet;
}

function renderControl(control: CloudControlEnvelope, includeRunId: boolean): string {
  const body = includeRunId
    ? control
    : {
        schemaVersion: control.schemaVersion,
        role: control.role,
        userScope: control.userScope,
        allowedResultKinds: control.allowedResultKinds,
        allowedChangeOperations: control.allowedChangeOperations,
        forbiddenCapabilities: control.forbiddenCapabilities,
        resultSchemaObjectDigest: control.resultSchemaObjectDigest,
        contextRequestPolicy: control.contextRequestPolicy,
      };
  return canonicalizeRfc8785(body);
}

function renderPayload(payload: InlinePayload): string {
  return `${payload.evidenceId}\n${payload.node.kind}\n${payloadBody(payload)}`;
}

function payloadsForKinds(packet: ContextPacket, kinds: ReadonlySet<string>): InlinePayload[] {
  return packet.evidencePayloads
    .filter((item) => kinds.has(item.node.kind))
    .sort((left, right) => {
      const byHierarchy = compareUtf8(hierarchySortKey(left.node), hierarchySortKey(right.node));
      if (byHierarchy !== 0) {
        return byHierarchy;
      }
      return compareUtf8(left.evidenceId, right.evidenceId);
    });
}

export function serializePacketSections(packet: ContextPacket, includeRunIdInControl: boolean): string {
  const causal = packet.bundles.filter((bundle) => bundle.purpose === "causal-path");
  const code = payloadsForKinds(packet, CODE_KINDS);
  const runtime = payloadsForKinds(packet, RUNTIME_KINDS);
  const conflictNodes = packet.evidencePayloads.filter((item) =>
    packet.conflicts.includes(item.evidenceId) || packet.unknowns.includes(item.evidenceId),
  );
  const sections = [
    renderControl(packet.control, includeRunIdInControl),
    canonicalizeRfc8785({
      originalRequest: packet.requirementLedger.originalRequest,
      requirements: packet.requirementLedger.requirements,
      nonGoals: packet.requirementLedger.nonGoals,
      conflicts: packet.requirementLedger.conflicts,
      openQuestions: packet.requirementLedger.openQuestions,
    }),
    canonicalizeRfc8785({
      instructions: packet.authoritativeInstructions,
      skills: packet.loadedSkills.map((item) => ({
        skillId: item.skillId,
        verbatimContent: item.verbatimContent,
      })),
    }),
    canonicalizeRfc8785(causal),
    canonicalizeRfc8785(packet.repositoryMap),
    code.map(renderPayload).join("\n"),
    runtime.map(renderPayload).join("\n"),
    conflictNodes.map(renderPayload).join("\n"),
    canonicalizeRfc8785(packet.verificationCapabilities),
    canonicalizeRfc8785(packet.omissionManifest),
    canonicalizeRfc8785({
      allowedResultKinds: packet.control.allowedResultKinds,
      resultSchemaObjectDigest: packet.control.resultSchemaObjectDigest,
      exactlyOneTerminalCallRequired: true,
    }),
  ];
  return SERIALIZATION_SECTION_TITLES.map((title, index) => `## ${title}\n${sections[index] ?? ""}`).join("\n\n");
}

export function toolSchemasJson(): { submit: JsonValue; request: JsonValue } {
  return {
    submit: jsonSchemaOf(SubmitSolutionToolParametersSchema),
    request: jsonSchemaOf(RequestContextToolParametersSchema),
  };
}

export function compileConversation(input: {
  packet: ContextPacket;
  binding: CloudRequestBinding;
  requestBindingDigest: CompiledCloudConversation["requestBindingDigest"];
  systemPrompt: string;
}): CompiledCloudConversation {
  const toolsJson = toolSchemasJson();
  const userText = serializePacketSections(input.packet, true);
  const conversation: CompiledCloudConversation = {
    schemaVersion: 1,
    requestBinding: input.binding,
    requestBindingDigest: input.requestBindingDigest,
    systemPrompt: input.systemPrompt,
    messages: [{ role: "user", content: [{ kind: "text", text: userText.length > 0 ? userText : "context" }] }],
    tools: [
      {
        name: "submit_solution",
        description: "Submit the terminal solution, no-change, or user-input result.",
        inputSchema: toolsJson.submit,
        inputSchemaObjectDigest: objectDigestOf(toolsJson.submit),
      },
      {
        name: "request_context",
        description: "Request additional unresolved evidence without solving.",
        inputSchema: toolsJson.request,
        inputSchemaObjectDigest: objectDigestOf(toolsJson.request),
      },
    ],
    allowedTerminalTools: ["submit_solution", "request_context"],
    exactlyOneTerminalCallRequired: true,
  };
  return conversation;
}

export function conversationBytes(conversation: CompiledCloudConversation): Uint8Array {
  return Buffer.from(canonicalizeRfc8785(conversation), "utf8");
}

export function packetContainsProhibited(packet: ContextPacket, needle: string): boolean {
  return canonicalizeRfc8785(packet).includes(needle);
}

export function sourcePathOf(ref: SourceRef): string | undefined {
  if (ref.origin === "repository") {
    return ref.path;
  }
  if (ref.origin === "external") {
    return ref.url;
  }
  return undefined;
}

export function redactPayloads(
  payloads: readonly InlinePayload[],
  projectClassification: DataClassification,
  intendedPatchPaths: readonly string[],
):
  | { kind: "ok"; payloads: InlinePayload[]; restricted: boolean; findings: DlpFinding[] }
  | { kind: "rejected"; code: "PATCH_DEPENDS_ON_REDACTED" } {
  const next: InlinePayload[] = [];
  const findings: DlpFinding[] = [];
  let restricted = false;
  for (const payload of payloads) {
    const first = payload.sources[0];
    const path = sourcePathOf(first.sourceRef);
    const sources: InlinePayload["sources"][number][] = [];
    for (const source of payload.sources) {
      const sourcePath = sourcePathOf(source.sourceRef) ?? path;
      const scanned = scanSourceContent({
        content: source.content,
        projectClassification,
        ...(sourcePath === undefined ? {} : { path: sourcePath }),
      });
      if (scanned.classification === "restricted" || !scanned.inspectable) {
        restricted = true;
      }
      findings.push(...scanned.findings);
      if (
        sourcePath !== undefined &&
        intendedPatchPaths.includes(sourcePath) &&
        scanned.findings.some((finding) => finding.redactionPermitted)
      ) {
        return { kind: "rejected", code: "PATCH_DEPENDS_ON_REDACTED" };
      }
      if (source.content.encoding === "utf-8") {
        sources.push({
          ...source,
          content: { encoding: "utf-8", text: scanned.redactedText },
        });
        continue;
      }
      const decodedUtf8 = Buffer.from(source.content.base64, "base64").toString("utf8");
      if (scanned.redactedText.length > 0 && scanned.redactedText !== decodedUtf8) {
        sources.push({
          ...source,
          content: { encoding: "utf-8", text: scanned.redactedText },
        });
        continue;
      }
      sources.push(source);
    }
    const head = sources[0];
    if (head === undefined) {
      continue;
    }
    next.push({
      ...payload,
      sources: [head, ...sources.slice(1)],
    });
  }
  return { kind: "ok", payloads: next, restricted, findings };
}

export function redactVerbatim(
  text: string,
  projectClassification: DataClassification,
  path?: string,
): { text: string; findings: DlpFinding[]; restricted: boolean } {
  const scanned = scanText({
    text,
    projectClassification,
    ...(path === undefined ? {} : { path }),
  });
  return {
    text: scanned.redactedText,
    findings: [...scanned.findings],
    restricted: scanned.classification === "restricted",
  };
}

export function collectSourceRefs(packet: ContextPacket): SourceRef[] {
  const refs: SourceRef[] = [];
  for (const instruction of packet.authoritativeInstructions) {
    refs.push(instruction.sourceRef);
  }
  for (const payload of packet.evidencePayloads) {
    for (const source of payload.sources) {
      refs.push(source.sourceRef);
    }
  }
  return refs;
}
