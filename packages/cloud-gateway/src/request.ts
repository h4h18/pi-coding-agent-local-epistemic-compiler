import {
  canonicalizeRfc8785,
  envelopeObjectDigest,
  objectDigestFromBytes,
  payloadDigest,
  taggedHash,
  type ArtifactEnvelope,
  type CanonicalCloudRequest,
  type CloudDispatch,
  type CompiledCloudConversation,
  type DeploymentCapabilities,
  type DomainDigest,
  type EgressManifest,
  type EnvelopeSignature,
  type JsonValue,
  type ObjectDigest,
  type PayloadDigest,
  type ProviderWireRequest,
} from "@pi-hec/contracts";
import { scanText } from "@pi-hec/security";
import { countCloudTokens, PI_HEC_CLOUD_TOKENIZER_REVISION } from "@pi-hec/models";

export type CapacityWaitingState =
  | "WAITING_INITIAL_CONTEXT_CAPACITY"
  | "WAITING_DELTA_CONTEXT_CAPACITY"
  | "WAITING_REPAIR_CONTEXT_CAPACITY"
  | "WAITING_INITIAL_OUTPUT_CAPACITY"
  | "WAITING_DELTA_OUTPUT_CAPACITY"
  | "WAITING_REPAIR_OUTPUT_CAPACITY";

export type SealedTokenization = {
  inputTokens: number;
  reservedOutputTokens: number;
  tokenizerRevision: string;
};

export type WireBuildOk = {
  kind: "wire";
  envelope: ArtifactEnvelope<ProviderWireRequest>;
  body: Uint8Array;
  providerWireRequestDigest: DomainDigest<"provider-wire-request">;
};

export type WireBuildResult =
  | WireBuildOk
  | { kind: "waiting"; state: CapacityWaitingState; inputTokens: number; reservedOutputTokens: number }
  | { kind: "rejected"; code: "DLP_RESTRICTED"; reason: string };

export type CredentialInjectResult =
  | {
      kind: "injected";
      headers: Record<string, string>;
      endpointIdentity: string;
      modelRevision: string;
      providerIdempotencyKey: string;
      body: Uint8Array;
      bodyObjectDigest: ObjectDigest;
    }
  | { kind: "not-approved" };

function jsonValue(value: unknown): JsonValue {
  const stripped: unknown = JSON.parse(JSON.stringify(value));
  return JSON.parse(canonicalizeRfc8785(stripped)) as JsonValue;
}

export function asObjectDigest(value: string): ObjectDigest {
  if (!value.startsWith("sha256:")) {
    throw new Error("object digest required");
  }
  return value as ObjectDigest;
}

function asPayloadDigest(value: string): PayloadDigest {
  if (!value.startsWith("sha256:")) {
    throw new Error("payload digest required");
  }
  return value as PayloadDigest;
}

export function unsignedEnvelope<TPayload>(
  schemaName: string,
  payload: TPayload,
): ArtifactEnvelope<TPayload> {
  return {
    schemaName,
    schemaVersion: 1,
    payload,
    payloadDigest: payloadDigest({
      schemaName,
      schemaVersion: 1,
      payload: jsonValue(payload),
    }),
    signatures: [],
  };
}

export function envelopeDigest(envelope: {
  schemaName: string;
  schemaVersion: number;
  payload: unknown;
  payloadDigest: string;
  signatures: readonly EnvelopeSignature[];
}): ObjectDigest {
  return envelopeObjectDigest({
    schemaName: envelope.schemaName,
    schemaVersion: envelope.schemaVersion,
    payload: jsonValue(envelope.payload),
    payloadDigest: asPayloadDigest(envelope.payloadDigest),
    signatures: envelope.signatures,
  });
}

export function providerWireRequestDigestOf(
  providerWireRequest: ProviderWireRequest,
): DomainDigest<"provider-wire-request"> {
  return taggedHash("provider-wire-request", 1, {
    providerWireRequest: jsonValue(providerWireRequest),
  });
}

function sortHeaders(
  headers: readonly { nameLowercase: string; value: string }[],
): { nameLowercase: string; value: string }[] {
  return [...headers].sort((left, right) => {
    const name = left.nameLowercase.localeCompare(right.nameLowercase);
    return name !== 0 ? name : left.value.localeCompare(right.value);
  });
}

function messageText(message: CompiledCloudConversation["messages"][number]): string {
  return message.content.map((part) => (part.kind === "text" ? part.text : part.canonicalUtf8)).join("\n");
}

export function isOpenAiShaped(capabilities: DeploymentCapabilities): boolean {
  return capabilities.providerApiVersion.includes("chat/completions");
}

export function providerBodyObject(
  conversation: CompiledCloudConversation,
  request: CanonicalCloudRequest,
  capabilities: DeploymentCapabilities,
): { [key: string]: JsonValue } {
  const model = request.requestBinding.modelRevision;
  if (isOpenAiShaped(capabilities)) {
    const messages: JsonValue[] = [{ role: "system", content: conversation.systemPrompt }];
    for (const message of conversation.messages) {
      if (message.role === "user") {
        messages.push({ role: "user", content: messageText(message) });
        continue;
      }
      if (message.role === "assistant") {
        const terminal = message.terminalCall;
        if (terminal === undefined) {
          messages.push({ role: "assistant", content: messageText(message) });
          continue;
        }
        const text = messageText(message);
        messages.push({
          role: "assistant",
          content: text.length > 0 ? text : null,
          tool_calls: [
            {
              id: terminal.callId,
              type: "function",
              function: { name: terminal.name, arguments: canonicalizeRfc8785(terminal.canonicalArguments) },
            },
          ],
        });
        continue;
      }
      messages.push({ role: "tool", tool_call_id: message.toolCallId, content: messageText(message) });
    }
    return {
      model,
      messages,
      tools: conversation.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      })),
      tool_choice: "required",
      parallel_tool_calls: false,
      max_tokens: request.maxOutputTokens,
      stream: true,
    };
  }
  const messages: JsonValue[] = [];
  for (const message of conversation.messages) {
    if (message.role === "tool") {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: messageText(message) }],
      });
      continue;
    }
    if (message.role === "assistant" && message.terminalCall !== undefined) {
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: message.terminalCall.callId,
            name: message.terminalCall.name,
            input: message.terminalCall.canonicalArguments,
          },
        ],
      });
      continue;
    }
    const text = messageText(message);
    messages.push({ role: message.role, content: text.length > 0 ? text : " " });
  }
  return {
    model,
    system: conversation.systemPrompt,
    messages,
    tools: conversation.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    })),
    tool_choice: { type: "any" },
    disable_parallel_tool_use: true,
    max_tokens: request.maxOutputTokens,
    stream: true,
  };
}

export function providerBodyBytes(
  conversation: CompiledCloudConversation,
  request: CanonicalCloudRequest,
  capabilities: DeploymentCapabilities,
): Uint8Array {
  return Buffer.from(JSON.stringify(providerBodyObject(conversation, request, capabilities)), "utf8");
}

function capacityStates(purpose: CanonicalCloudRequest["purpose"]): {
  context: CapacityWaitingState;
  output: CapacityWaitingState;
} {
  switch (purpose) {
    case "initial":
      return { context: "WAITING_INITIAL_CONTEXT_CAPACITY", output: "WAITING_INITIAL_OUTPUT_CAPACITY" };
    case "context-followup":
      return { context: "WAITING_DELTA_CONTEXT_CAPACITY", output: "WAITING_DELTA_OUTPUT_CAPACITY" };
    case "repair":
      return { context: "WAITING_REPAIR_CONTEXT_CAPACITY", output: "WAITING_REPAIR_OUTPUT_CAPACITY" };
    default: {
      const exhaustive: never = purpose;
      throw new Error(`unhandled purpose ${String(exhaustive)}`);
    }
  }
}

export function buildProviderWireRequest(input: {
  request: ArtifactEnvelope<CanonicalCloudRequest>;
  conversation: ArtifactEnvelope<CompiledCloudConversation>;
  egress: ArtifactEnvelope<EgressManifest>;
  capabilities: DeploymentCapabilities;
  tokenization: SealedTokenization;
}): WireBuildResult {
  const request = input.request.payload;
  const body = providerBodyBytes(input.conversation.payload, request, input.capabilities);
  const scanned = scanText({ text: Buffer.from(body).toString("utf8") });
  if (scanned.classification === "restricted") {
    return { kind: "rejected", code: "DLP_RESTRICTED", reason: "restricted bytes in provider wire body" };
  }
  const states = capacityStates(request.purpose);
  const maxOutput = input.capabilities.context.maxOutputTokens ?? request.maxOutputTokens;
  const reserved = input.tokenization.reservedOutputTokens;
  const tokens = countCloudTokens(Buffer.from(body).toString("utf8"), input.tokenization.tokenizerRevision);
  if (tokens === undefined || input.tokenization.tokenizerRevision !== PI_HEC_CLOUD_TOKENIZER_REVISION) {
    return {
      kind: "waiting",
      state: states.context,
      inputTokens: input.tokenization.inputTokens,
      reservedOutputTokens: reserved,
    };
  }
  if (tokens > input.tokenization.inputTokens) {
    return { kind: "waiting", state: states.context, inputTokens: tokens, reservedOutputTokens: reserved };
  }
  if (reserved > maxOutput) {
    return { kind: "waiting", state: states.output, inputTokens: tokens, reservedOutputTokens: reserved };
  }
  if (tokens + reserved > input.capabilities.context.nativeTokens) {
    return { kind: "waiting", state: states.context, inputTokens: tokens, reservedOutputTokens: reserved };
  }
  const requestEnvelopeObjectDigest = envelopeDigest(input.request);
  const headers = sortHeaders(
    isOpenAiShaped(input.capabilities)
      ? [
          { nameLowercase: "accept", value: "text/event-stream" },
          { nameLowercase: "content-type", value: "application/json" },
        ]
      : [
          { nameLowercase: "accept", value: "text/event-stream" },
          { nameLowercase: "anthropic-version", value: input.capabilities.providerApiVersion },
          { nameLowercase: "content-type", value: "application/json" },
        ],
  );
  const wire: ProviderWireRequest = {
    schemaVersion: 1,
    requestEnvelopeObjectDigest,
    deploymentId: request.deploymentId,
    adapterVersionObjectDigest: request.adapterVersionObjectDigest,
    endpointIdentity: input.egress.payload.endpointIdentity,
    providerApiVersion: input.capabilities.providerApiVersion,
    modelRevision: request.requestBinding.modelRevision,
    method: "POST",
    nonSecretHeaders: headers,
    bodyMediaType: "application/json",
    bodyObjectDigest: objectDigestFromBytes(body),
    bodyByteSize: body.byteLength,
    providerIdempotencyKey: requestEnvelopeObjectDigest,
  };
  return {
    kind: "wire",
    envelope: unsignedEnvelope("ProviderWireRequest", wire),
    body,
    providerWireRequestDigest: providerWireRequestDigestOf(wire),
  };
}

export function injectSealedAuthorization(input: {
  wire: ProviderWireRequest;
  body: Uint8Array;
  approved: boolean;
  approvedProviderWireRequestObjectDigest: ObjectDigest;
  wireEnvelopeObjectDigest: ObjectDigest;
  authorization: string;
}): CredentialInjectResult {
  if (!input.approved || input.approvedProviderWireRequestObjectDigest !== input.wireEnvelopeObjectDigest) {
    return { kind: "not-approved" };
  }
  const headers: Record<string, string> = {};
  for (const header of input.wire.nonSecretHeaders) {
    headers[header.nameLowercase] = header.value;
  }
  headers.authorization = input.authorization;
  return {
    kind: "injected",
    headers,
    endpointIdentity: input.wire.endpointIdentity,
    modelRevision: input.wire.modelRevision,
    providerIdempotencyKey: input.wire.providerIdempotencyKey,
    body: input.body,
    bodyObjectDigest: asObjectDigest(input.wire.bodyObjectDigest),
  };
}

export function wireDispatchBindingsMatch(
  dispatch: CloudDispatch,
  capabilities: DeploymentCapabilities,
  reconstructedBody: Uint8Array,
): boolean {
  const request = dispatch.request.payload;
  const wire = dispatch.wireRequest.payload;
  const conversationPayload = payloadDigest({
    schemaName: dispatch.conversation.schemaName,
    schemaVersion: dispatch.conversation.schemaVersion,
    payload: jsonValue(dispatch.conversation.payload),
  });
  return (
    objectDigestFromBytes(reconstructedBody) === wire.bodyObjectDigest &&
    envelopeDigest(dispatch.request) === wire.requestEnvelopeObjectDigest &&
    envelopeDigest(dispatch.wireRequest) === envelopeDigest(unsignedEnvelope("ProviderWireRequest", wire)) &&
    wire.providerIdempotencyKey === wire.requestEnvelopeObjectDigest &&
    wire.endpointIdentity === dispatch.egress.payload.endpointIdentity &&
    wire.modelRevision === request.requestBinding.modelRevision &&
    wire.modelRevision === capabilities.modelRevision &&
    wire.adapterVersionObjectDigest === request.adapterVersionObjectDigest &&
    wire.adapterVersionObjectDigest === capabilities.adapterVersionObjectDigest &&
    wire.deploymentId === request.deploymentId &&
    wire.deploymentId === capabilities.deploymentId &&
    dispatch.conversation.payloadDigest === conversationPayload
  );
}
