import { Compile } from "typebox/compile";
import {
  CloudResultSchema,
  asObjectDigest,
  objectDigestFromBytes,
  type CloudCompletionReceipt,
  type CloudDispatch,
  type CloudDispatchResult,
  type CloudRecoveryLookupKey,
  type CloudResult,
  type DeploymentCapabilities,
  type NormalizedUsage,
  type ObjectDigest,
} from "@pi-hec/contracts";
import { postOnce, recoveryAdapterFor, type CloudCompletionAdapter } from "@pi-hec/models";
import { recoveryMatchesCapabilities } from "./capabilities.js";
import {
  envelopeDigest,
  injectSealedAuthorization,
  providerBodyBytes,
  providerWireRequestDigestOf,
  wireDispatchBindingsMatch,
} from "./request.js";

const RESULT = Compile(CloudResultSchema);
const RESPONSE_MAX_BYTES = 1_048_576;
const EMPTY_USAGE: NormalizedUsage = {
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  cachedInputTokens: null,
  cacheWriteTokens: null,
  totalTokens: null,
  providerReported: false,
  complete: false,
  estimatedCost: null,
};

export type OneShotAdapterOptions = {
  capabilities: DeploymentCapabilities;
  approved: boolean;
  approvedProviderWireRequestObjectDigest: ObjectDigest;
  authorization: string;
  fetchImpl?: typeof fetch;
  now?: () => string;
  putBytes?: (bytes: Uint8Array) => ObjectDigest | Promise<ObjectDigest>;
};

type ToolCall = { name: string; argumentsText: string };
type Finish = "tool_calls" | "stop" | "length" | "cancelled" | "error" | undefined;
type ParsedOutput = { finish: Finish; tools: ToolCall[]; text: string; overflow: boolean; truncatedStream: boolean };

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function mapFinish(value: string | undefined): Finish {
  if (value === "tool_calls" || value === "tool_use") {
    return "tool_calls";
  }
  if (value === "stop" || value === "end_turn") {
    return "stop";
  }
  if (value === "length" || value === "max_tokens") {
    return "length";
  }
  if (value === "cancelled" || value === "aborted") {
    return "cancelled";
  }
  return value === undefined ? undefined : "error";
}

function collectOpenAiTools(message: { [key: string]: unknown }, tools: ToolCall[]): string {
  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const item of toolCalls) {
      if (!isRecord(item)) {
        continue;
      }
      const fn = isRecord(item.function) ? item.function : {};
      const index = typeof item.index === "number" ? item.index : tools.length;
      const current = tools[index] ?? { name: "", argumentsText: "" };
      tools[index] = {
        name: asString(fn.name) ?? current.name,
        argumentsText: `${current.argumentsText}${asString(fn.arguments) ?? ""}`,
      };
    }
  }
  return asString(message.content) ?? "";
}

function collectAnthropic(content: unknown, tools: ToolCall[]): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : "";
  }
  let text = "";
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "tool_use") {
      tools.push({ name: asString(block.name) ?? "", argumentsText: JSON.stringify(block.input ?? {}) });
    }
    if (block.type === "text") {
      text += asString(block.text) ?? "";
    }
    if (block.type === "input_json_delta") {
      const last = tools[tools.length - 1];
      if (last !== undefined) {
        last.argumentsText += asString(block.partial_json) ?? "";
      }
    }
  }
  return text;
}

function parseProviderPayload(text: string, tools: ToolCall[]): { finish: Finish; bodyText: string } {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    return { finish: undefined, bodyText: "" };
  }
  const choices = parsed.choices;
  if (Array.isArray(choices) && isRecord(choices[0])) {
    const choice = choices[0];
    const message = isRecord(choice.message) ? choice.message : isRecord(choice.delta) ? choice.delta : {};
    return { finish: mapFinish(asString(choice.finish_reason)), bodyText: collectOpenAiTools(message, tools) };
  }
  return { finish: mapFinish(asString(parsed.stop_reason)), bodyText: collectAnthropic(parsed.content, tools) };
}

function parseSse(raw: string): ParsedOutput {
  const tools: ToolCall[] = [];
  let finish: Finish;
  let bodyText = "";
  let truncatedStream = true;
  for (const block of raw.split(/\n\n/u)) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (data === "[DONE]") {
      truncatedStream = false;
      continue;
    }
    if (data.length === 0) {
      continue;
    }
    try {
      const piece = parseProviderPayload(data, tools);
      if (piece.finish !== undefined) {
        finish = piece.finish;
        truncatedStream = false;
      }
      bodyText += piece.bodyText;
    } catch {
      truncatedStream = true;
    }
  }
  return {
    finish,
    tools: tools.filter((item) => item.name.length > 0 || item.argumentsText.length > 0),
    text: bodyText,
    overflow: false,
    truncatedStream,
  };
}

function parseBody(raw: Buffer, contentType: string, overflow: boolean): ParsedOutput {
  const text = raw.toString("utf8");
  if (overflow) {
    return { finish: "length", tools: [], text, overflow: true, truncatedStream: true };
  }
  if (contentType.includes("json") && !contentType.includes("event-stream") && text.trim().startsWith("{")) {
    const tools: ToolCall[] = [];
    try {
      const piece = parseProviderPayload(text, tools);
      return { finish: piece.finish, tools, text: piece.bodyText, overflow: false, truncatedStream: piece.finish === undefined };
    } catch {
      return { finish: undefined, tools: [], text, overflow: false, truncatedStream: true };
    }
  }
  return parseSse(text);
}

async function readLimited(response: Response, signal: AbortSignal): Promise<{ bytes: Buffer; overflow: boolean }> {
  const chunks: Buffer[] = [];
  if (response.body === null) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return { bytes: buffer.subarray(0, RESPONSE_MAX_BYTES), overflow: buffer.byteLength > RESPONSE_MAX_BYTES };
  }
  const reader = response.body.getReader();
  let size = 0;
  for (;;) {
    if (signal.aborted) {
      await reader.cancel();
      return { bytes: Buffer.concat(chunks), overflow: false };
    }
    const raw: unknown = await reader.read();
    if (!isRecord(raw)) {
      break;
    }
    if (raw.done === true) {
      break;
    }
    const value = raw.value;
    if (!(value instanceof Uint8Array)) {
      continue;
    }
    size += value.byteLength;
    if (size > RESPONSE_MAX_BYTES) {
      await reader.cancel();
      return { bytes: Buffer.concat(chunks), overflow: true };
    }
    chunks.push(Buffer.from(value));
  }
  return { bytes: Buffer.concat(chunks), overflow: false };
}

function bindingsMatch(result: CloudResult, dispatch: CloudDispatch): boolean {
  const request = dispatch.request.payload;
  const binding = request.requestBinding;
  return (
    result.runId === request.runId &&
    result.cloudCallId === request.cloudCallId &&
    result.requestBindingDigest === request.requestBindingDigest &&
    result.contextPacketObjectDigest === request.contextPacketObjectDigest &&
    result.baseSnapshotId === binding.baseSnapshotId &&
    result.baseSnapshotRootDigest === binding.baseSnapshotRootDigest
  );
}

function lookupKeysOf(
  recovery: ReturnType<typeof recoveryAdapterFor>,
  requestEnvelopeObjectDigest: ObjectDigest,
  providerOperationId: string | undefined,
): CloudRecoveryLookupKey[] {
  switch (recovery.grade) {
    case "C":
      return [];
    case "B":
      return providerOperationId === undefined
        ? []
        : [{ kind: "provider-operation-id", value: providerOperationId }];
    case "A":
      return [{ kind: "request-object", requestEnvelopeObjectDigest }];
    default: {
      const exhaustive: never = recovery;
      throw new Error(`unhandled recovery ${String(exhaustive)}`);
    }
  }
}

const PROVEN_NOT_ACCEPTED_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NODATA",
  "EAI_NONAME",
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_NAME_NOT_RESOLVED",
]);

function collectErrorCodes(error: unknown, seen: Set<unknown>): string[] {
  if (error === null || error === undefined || seen.has(error)) {
    return [];
  }
  seen.add(error);
  if (typeof error !== "object") {
    return [];
  }
  const codes: string[] = [];
  if ("code" in error && typeof error.code === "string") {
    codes.push(error.code);
  }
  if ("name" in error && error.name === "AbortError") {
    codes.push("AbortError");
  }
  if ("cause" in error) {
    codes.push(...collectErrorCodes(error.cause, seen));
  }
  return codes;
}

function classifyPostOnceThrow(error: unknown): "not-dispatched" | "accepted-outcome-unknown" {
  const codes = collectErrorCodes(error, new Set());
  if (codes.some((code) => PROVEN_NOT_ACCEPTED_CODES.has(code))) {
    return "not-dispatched";
  }
  return "accepted-outcome-unknown";
}

function decodeResult(
  parsed: ParsedOutput,
  dispatch: CloudDispatch,
): { kind: "ok"; result: CloudResult; finish: "tool_calls" | "stop" } | { kind: "protocol"; message: string } {
  if (parsed.tools.length > 1) {
    return { kind: "protocol", message: "multiple tool calls" };
  }
  const tool = parsed.tools[0];
  if (tool !== undefined) {
    if (tool.name !== "submit_solution" && tool.name !== "request_context") {
      return { kind: "protocol", message: "forbidden tool" };
    }
    if (tool.argumentsText.length > RESPONSE_MAX_BYTES) {
      return { kind: "protocol", message: "changeset exceeds safety storage" };
    }
    let args: unknown;
    try {
      args = JSON.parse(tool.argumentsText);
    } catch {
      return { kind: "protocol", message: "malformed tool arguments" };
    }
    if (!RESULT.Check(args) || !bindingsMatch(args, dispatch)) {
      return { kind: "protocol", message: "tool arguments failed CloudResult schema or bindings" };
    }
    return { kind: "ok", result: args, finish: "tool_calls" };
  }
  if (dispatch.request.payload.resultMode === "strict-json-schema" && parsed.text.length > 0) {
    let value: unknown;
    try {
      value = JSON.parse(parsed.text);
    } catch {
      return { kind: "protocol", message: "malformed JSON" };
    }
    if (!RESULT.Check(value) || !bindingsMatch(value, dispatch)) {
      return { kind: "protocol", message: "JSON failed CloudResult schema or bindings" };
    }
    return { kind: "ok", result: value, finish: "stop" };
  }
  return { kind: "protocol", message: "exactly one terminal result is required" };
}

export function createOneShotAdapter(options: OneShotAdapterOptions): CloudCompletionAdapter {
  const recovery = recoveryAdapterFor(options.capabilities);
  if (!recoveryMatchesCapabilities(options.capabilities, recovery)) {
    throw new Error("recovery adapter grade does not match DeploymentCapabilities");
  }
  const now = options.now ?? (() => new Date().toISOString());
  const putBytes = options.putBytes ?? ((bytes: Uint8Array) => objectDigestFromBytes(bytes));
  const fetchImpl = options.fetchImpl ?? fetch;
  const capabilities = options.capabilities;

  async function digestBytes(bytes: Uint8Array): Promise<ObjectDigest> {
    return await putBytes(bytes);
  }

  function baseReceipt(dispatch: CloudDispatch) {
    const wire = dispatch.wireRequest.payload;
    return {
      schemaVersion: 1 as const,
      runId: dispatch.request.payload.runId,
      cloudCallId: dispatch.request.payload.cloudCallId,
      requestEnvelopeObjectDigest: asObjectDigest(wire.requestEnvelopeObjectDigest),
      providerWireRequestObjectDigest: envelopeDigest(dispatch.wireRequest),
      providerWireRequestDigest: providerWireRequestDigestOf(wire),
      deploymentId: wire.deploymentId,
      completedAt: now(),
      usage: EMPTY_USAGE,
    };
  }

  function notDispatched(
    dispatch: CloudDispatch,
    evidence: ObjectDigest,
    code: string,
    message: string,
  ): CloudDispatchResult {
    const receipt: Extract<CloudCompletionReceipt, { outcome: "FAILED"; acceptedness: "PROVEN_NOT_ACCEPTED" }> = {
      ...baseReceipt(dispatch),
      outcome: "FAILED",
      acceptedness: "PROVEN_NOT_ACCEPTED",
      finishReason: "error",
      transportEvidenceObjectDigest: evidence,
      error: { code, retryClass: "SAFE_SAME_REQUEST", message },
    };
    return { state: "not-dispatched", reasonCode: code, receipt };
  }

  function incomplete(
    dispatch: CloudDispatch,
    incident: ObjectDigest,
    finishReason: "length" | "cancelled",
  ): CloudDispatchResult {
    return {
      state: "completed",
      receipt: {
        ...baseReceipt(dispatch),
        outcome: "INCOMPLETE",
        acceptedAt: now(),
        finishReason,
        incidentRecordObjectDigest: incident,
        error: {
          code: finishReason === "length" ? "INCOMPLETE" : "CANCELLED",
          retryClass: finishReason === "length" ? "DO_NOT_RETRY" : "RECONCILE_FIRST",
          message: finishReason === "length" ? "finish_reason=length" : "stream cancelled",
        },
      },
    };
  }

  return {
    deploymentId: capabilities.deploymentId,
    recovery,
    capabilities: (signal) => {
      void signal;
      return Promise.resolve(capabilities);
    },
    async completeOnce(dispatch, signal) {
      const reconstructed = providerBodyBytes(dispatch.conversation.payload, dispatch.request.payload, capabilities);
      if (!wireDispatchBindingsMatch(dispatch, capabilities, reconstructed)) {
        return notDispatched(
          dispatch,
          await digestBytes(Buffer.from("binding-mismatch", "utf8")),
          "WIRE_BINDING_MISMATCH",
          "re-hashed conversation/wire bindings do not match the sealed envelopes",
        );
      }
      const wireEnvelopeObjectDigest = envelopeDigest(dispatch.wireRequest);
      const injected = injectSealedAuthorization({
        wire: dispatch.wireRequest.payload,
        body: reconstructed,
        approved: options.approved,
        approvedProviderWireRequestObjectDigest: options.approvedProviderWireRequestObjectDigest,
        wireEnvelopeObjectDigest,
        authorization: options.authorization,
      });
      if (injected.kind === "not-approved") {
        return notDispatched(dispatch, await digestBytes(Buffer.from("approval-missing", "utf8")), "APPROVAL_MISSING", "provider-wire approval is missing");
      }
      let response: Response;
      try {
        response = await postOnce({
          url: injected.endpointIdentity,
          headers: injected.headers,
          body: injected.body,
          signal,
          fetchImpl,
          maxRetries: 0,
        });
      } catch (error) {
        const classified = classifyPostOnceThrow(error);
        if (classified === "not-dispatched") {
          return notDispatched(
            dispatch,
            await digestBytes(Buffer.from("transport-error", "utf8")),
            "NOT_DISPATCHED",
            "provider request was not accepted",
          );
        }
        return {
          state: "accepted-outcome-unknown",
          availableLookupKeys: lookupKeysOf(recovery, asObjectDigest(dispatch.wireRequest.payload.requestEnvelopeObjectDigest), undefined),
          transportEvidenceObjectDigest: await digestBytes(Buffer.from("transport-ambiguous", "utf8")),
        };
      }
      if (response.status === 429 || response.status === 400 || response.status === 401 || response.status === 403) {
        return notDispatched(
          dispatch,
          await digestBytes(Buffer.from(`status:${String(response.status)}`, "utf8")),
          "PROVEN_NOT_ACCEPTED",
          `provider rejected with ${String(response.status)}`,
        );
      }
      const requestDigest = asObjectDigest(dispatch.wireRequest.payload.requestEnvelopeObjectDigest);
      if (response.status < 200 || response.status >= 300) {
        return {
          state: "accepted-outcome-unknown",
          availableLookupKeys: lookupKeysOf(recovery, requestDigest, undefined),
          transportEvidenceObjectDigest: await digestBytes(Buffer.from(`status:${String(response.status)}`, "utf8")),
        };
      }
      let collected: { bytes: Buffer; overflow: boolean };
      try {
        collected = await readLimited(response, signal);
      } catch {
        return {
          state: "accepted-outcome-unknown",
          availableLookupKeys: lookupKeysOf(recovery, requestDigest, undefined),
          transportEvidenceObjectDigest: await digestBytes(Buffer.from("stream-drop", "utf8")),
        };
      }
      const parsed = parseBody(collected.bytes, response.headers.get("content-type") ?? "", collected.overflow);
      if (parsed.truncatedStream && parsed.finish === undefined && recovery.grade === "C") {
        return {
          state: "accepted-outcome-unknown",
          availableLookupKeys: [],
          transportEvidenceObjectDigest: await digestBytes(collected.bytes),
        };
      }
      if (parsed.overflow || parsed.finish === "length") {
        return incomplete(dispatch, await digestBytes(collected.bytes), "length");
      }
      if (parsed.finish === "cancelled") {
        return incomplete(dispatch, await digestBytes(collected.bytes), "cancelled");
      }
      const decoded = decodeResult(parsed, dispatch);
      if (decoded.kind === "protocol") {
        return {
          state: "completed",
          receipt: {
            ...baseReceipt(dispatch),
            outcome: "FAILED",
            acceptedness: "ACCEPTED",
            acceptedAt: now(),
            finishReason: "error",
            incidentRecordObjectDigest: await digestBytes(collected.bytes),
            error: { code: "MODEL_PROTOCOL_ERROR", retryClass: "DO_NOT_RETRY", message: decoded.message },
          },
        };
      }
      return {
        state: "completed",
        receipt: {
          ...baseReceipt(dispatch),
          outcome: "VALID_RESULT",
          acceptedAt: now(),
          finishReason: decoded.finish,
          rawResponseArtifactObjectDigest: await digestBytes(collected.bytes),
          result: decoded.result,
          resultObjectDigest: objectDigestFromBytes(Buffer.from(JSON.stringify(decoded.result), "utf8")),
        },
      };
    },
  };
}
