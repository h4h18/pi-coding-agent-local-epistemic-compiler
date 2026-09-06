import {
  canonicalizeRfc8785,
  payloadDigest,
  sha256Utf8,
  type ArtifactEnvelope,
  type CanonicalCloudRequest,
  type CloudDispatch,
  type CloudResult,
  type CompiledCloudConversation,
  type DeploymentCapabilities,
  type EgressManifest,
  type JsonValue,
  type ObjectDigest,
} from "@pi-hec/contracts";
import { PI_HEC_CLOUD_TOKENIZER_REVISION, loadCloudCapabilityRecords } from "@pi-hec/models";
import {
  buildProviderWireRequest,
  unsignedEnvelope,
  type SealedTokenization,
} from "../src/index.js";

export const RUN = "run_01234567-89ab-7cde-8f01-23456789abcd";
export const CALL = "call_01234567-89ab-7cde-8f01-23456789abcd";
export const SNAP = "snap_01234567-89ab-7cde-8f01-23456789abcd";
export const TS = "2026-08-28T00:00:00.000Z";
export const EVIDENCE = `evidence_${"a".repeat(52)}`;
export const ZERO = sha256Utf8("zero-digest");

export function jsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalizeRfc8785(value)) as JsonValue;
}

export function bodyField(body: Uint8Array, key: string): JsonValue | undefined {
  const parsed: unknown = JSON.parse(Buffer.from(body).toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("provider body is not a JSON object");
  }
  if (!Object.hasOwn(parsed, key)) {
    return undefined;
  }
  return jsonValue(Reflect.get(parsed, key));
}

export function openaiCapabilities(): DeploymentCapabilities {
  const records = loadCloudCapabilityRecords();
  const found = records.find((item) => item.deploymentId === "openai-shaped-unknown");
  if (found === undefined) {
    throw new Error("missing openai-shaped-unknown fixture");
  }
  return found;
}

export function secondCapabilities(): DeploymentCapabilities {
  const records = loadCloudCapabilityRecords();
  const found = records.find((item) => item.deploymentId === "second-provider-grade-c");
  if (found === undefined) {
    throw new Error("missing second-provider-grade-c fixture");
  }
  return found;
}

export function cloudResult(): CloudResult {
  return {
    schemaVersion: 1,
    runId: RUN,
    cloudCallId: CALL,
    requestBindingDigest: ZERO,
    contextPacketObjectDigest: ZERO,
    baseSnapshotId: SNAP,
    baseSnapshotRootDigest: ZERO,
    kind: "request_context",
    missingClaimIds: [EVIDENCE],
    requestedEvidenceKinds: ["file"],
    pathOrSymbolHints: [],
    requestedSkillIds: [],
    reason: "need additional parse evidence",
  };
}

export function conversationOf(capabilities: DeploymentCapabilities): CompiledCloudConversation {
  const schema = jsonValue({ type: "object" });
  return {
    schemaVersion: 1,
    requestBinding: {
      schemaVersion: 1,
      purpose: "initial",
      runId: RUN,
      cloudCallId: CALL,
      contextPacketObjectDigest: ZERO,
      baseSnapshotId: SNAP,
      baseSnapshotRootDigest: ZERO,
      deploymentId: capabilities.deploymentId,
      adapterVersionObjectDigest: capabilities.adapterVersionObjectDigest,
      modelRevision: capabilities.modelRevision,
      resultSchemaObjectDigest: ZERO,
    },
    requestBindingDigest: ZERO,
    systemPrompt: "cloud-executor",
    messages: [{ role: "user", content: [{ kind: "text", text: "fix parse" }] }],
    tools: [
      {
        name: "submit_solution",
        description: "Submit the terminal solution",
        inputSchema: schema,
        inputSchemaObjectDigest: ZERO,
      },
      {
        name: "request_context",
        description: "Request additional evidence",
        inputSchema: schema,
        inputSchemaObjectDigest: ZERO,
      },
    ],
    allowedTerminalTools: ["submit_solution", "request_context"],
    exactlyOneTerminalCallRequired: true,
  };
}

export function canonicalOf(capabilities: DeploymentCapabilities): CanonicalCloudRequest {
  const binding = conversationOf(capabilities).requestBinding;
  if (binding.purpose !== "initial") {
    throw new Error("fixture binding must be initial");
  }
  return {
    schemaVersion: 1,
    purpose: "initial",
    runId: RUN,
    cloudCallId: CALL,
    requestBindingDigest: ZERO,
    deploymentId: capabilities.deploymentId,
    adapterVersionObjectDigest: capabilities.adapterVersionObjectDigest,
    contextPacketObjectDigest: ZERO,
    egressManifestObjectDigest: ZERO,
    compiledConversationObjectDigest: ZERO,
    resultMode: "terminal-tools",
    maxOutputTokens: 256,
    reasoningProfile: "none",
    requestBinding: binding,
  };
}

export function egressOf(capabilities: DeploymentCapabilities, endpoint: string): EgressManifest {
  return {
    schemaVersion: 1,
    runId: RUN,
    snapshotId: SNAP,
    contextPacketObjectDigest: ZERO,
    deploymentId: capabilities.deploymentId,
    adapterVersionObjectDigest: capabilities.adapterVersionObjectDigest,
    endpointIdentity: endpoint,
    providerChain: [capabilities.deploymentId],
    modelRevision: capabilities.modelRevision,
    retentionPolicyObjectDigest: ZERO,
    classification: "internal",
    sourceRefs: [],
    redactions: [],
    scannerVersions: ["pi-hec-dlp/1.0.0"],
    compiledConversationObjectDigest: ZERO,
    expiresAt: "2026-08-28T01:00:00.000Z",
  };
}

export function tokenization(overrides: Partial<SealedTokenization> = {}): SealedTokenization {
  return {
    inputTokens: 8192,
    reservedOutputTokens: 16,
    tokenizerRevision: PI_HEC_CLOUD_TOKENIZER_REVISION,
    ...overrides,
  };
}

export function envelope<TPayload>(
  schemaName: string,
  payload: TPayload,
): ArtifactEnvelope<TPayload> {
  return unsignedEnvelope(schemaName, payload);
}

export type BuiltDispatch = {
  dispatch: CloudDispatch;
  body: Uint8Array;
  request: ArtifactEnvelope<CanonicalCloudRequest>;
  conversation: ArtifactEnvelope<CompiledCloudConversation>;
  egress: ArtifactEnvelope<EgressManifest>;
};

export function buildDispatch(
  capabilities: DeploymentCapabilities,
  endpoint: string,
  capacity: SealedTokenization = tokenization(),
): BuiltDispatch {
  const request = envelope("CanonicalCloudRequest", canonicalOf(capabilities));
  const conversation = envelope("CompiledCloudConversation", conversationOf(capabilities));
  const egress = envelope("EgressManifest", egressOf(capabilities, endpoint));
  const built = buildProviderWireRequest({
    request,
    conversation,
    egress,
    capabilities,
    tokenization: capacity,
  });
  if (built.kind !== "wire") {
    throw new Error(`expected wire request, got ${built.kind}`);
  }
  return {
    dispatch: { request, egress, conversation, wireRequest: built.envelope },
    body: built.body,
    request,
    conversation,
    egress,
  };
}

export function openaiToolResponse(result: CloudResult = cloudResult()): string {
  return JSON.stringify({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          tool_calls: [
            {
              id: "tool-1",
              type: "function",
              index: 0,
              function: { name: "request_context", arguments: JSON.stringify(result) },
            },
          ],
        },
      },
    ],
  });
}

export function anthropicToolResponse(result: CloudResult = cloudResult()): string {
  return JSON.stringify({
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "tool-1", name: "request_context", input: result }],
  });
}

export function countingFetch(handler: (request: Request) => Promise<Response> | Response): {
  fetchImpl: typeof fetch;
  hits: () => number;
  bodies: () => string[];
  authorization: () => string | null;
} {
  let hits = 0;
  const bodies: string[] = [];
  let authorization: string | null = null;
  const fetchImpl: typeof fetch = async (input, init) => {
    hits += 1;
    const request = new Request(input, init);
    bodies.push(await request.clone().text());
    authorization = request.headers.get("authorization");
    return handler(request);
  };
  return {
    fetchImpl,
    hits: () => hits,
    bodies: () => bodies,
    authorization: () => authorization,
  };
}

export function jsonResponse(
  body: string,
  status = 200,
  contentType = "application/json",
): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

export type { ObjectDigest };
export { payloadDigest };
