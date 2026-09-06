import { ReadableStream } from "node:stream/web";
import { expect, test } from "vitest";
import { objectDigestFromBytes, sha256Utf8 } from "@pi-hec/contracts";
import {
  countCloudTokens,
  loadCloudCapabilityRecords,
  PI_HEC_CLOUD_TOKENIZER_REVISION,
  recoveryAdapterFor,
} from "@pi-hec/models";
import {
  buildProviderWireRequest,
  createOneShotAdapter,
  envelopeDigest,
  injectSealedAuthorization,
  providerBodyBytes,
  selectDeploymentBeforeDispatch,
} from "../src/index.js";
import {
  TS,
  anthropicToolResponse,
  bodyField,
  buildDispatch,
  countingFetch,
  jsonResponse,
  openaiCapabilities,
  openaiToolResponse,
  secondCapabilities,
  tokenization,
} from "./helpers.js";

test("normal path issues exactly one provider completion", async () => {
  const capabilities = openaiCapabilities();
  const http = countingFetch(() => jsonResponse(openaiToolResponse()));
  const { dispatch } = buildDispatch(capabilities, "http://127.0.0.1:9/v1/chat/completions");
  const adapter = createOneShotAdapter({
    capabilities,
    approved: true,
    approvedProviderWireRequestObjectDigest: envelopeDigest(dispatch.wireRequest),
    authorization: "Bearer sealed",
    fetchImpl: http.fetchImpl,
    now: () => TS,
  });
  const result = await adapter.completeOnce(dispatch, new AbortController().signal);
  expect(http.hits()).toBe(1);
  expect(result.state).toBe("completed");
  if (result.state === "completed") {
    expect(result.receipt.outcome).toBe("VALID_RESULT");
    expect(result.receipt.requestEnvelopeObjectDigest).toBe(
      dispatch.wireRequest.payload.requestEnvelopeObjectDigest,
    );
  }
});

test("tool result is never posted back as a second request with role tool", async () => {
  const capabilities = openaiCapabilities();
  const http = countingFetch(() => jsonResponse(openaiToolResponse()));
  const { dispatch } = buildDispatch(capabilities, "http://127.0.0.1:9/v1/chat/completions");
  const adapter = createOneShotAdapter({
    capabilities,
    approved: true,
    approvedProviderWireRequestObjectDigest: envelopeDigest(dispatch.wireRequest),
    authorization: "Bearer sealed",
    fetchImpl: http.fetchImpl,
    now: () => TS,
  });
  await adapter.completeOnce(dispatch, new AbortController().signal);
  expect(http.hits()).toBe(1);
  expect(http.bodies().some((body) => body.includes('"role":"tool"'))).toBe(false);
});

test("finish_reason=length is incomplete and does not issue a second completion", async () => {
  const capabilities = openaiCapabilities();
  const http = countingFetch(() =>
    jsonResponse(
      JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "partial" } }] }),
    ),
  );
  const { dispatch } = buildDispatch(capabilities, "http://127.0.0.1:9/v1/chat/completions");
  const adapter = createOneShotAdapter({
    capabilities,
    approved: true,
    approvedProviderWireRequestObjectDigest: envelopeDigest(dispatch.wireRequest),
    authorization: "Bearer sealed",
    fetchImpl: http.fetchImpl,
    now: () => TS,
  });
  const result = await adapter.completeOnce(dispatch, new AbortController().signal);
  expect(http.hits()).toBe(1);
  expect(result.state).toBe("completed");
  if (result.state === "completed") {
    expect(result.receipt.outcome).toBe("INCOMPLETE");
  }
});

test("multiple tool calls and malformed JSON are protocol failures without a hidden repair completion", async () => {
  const capabilities = openaiCapabilities();
  const multi = countingFetch(() =>
    jsonResponse(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [
                { function: { name: "request_context", arguments: "{}" } },
                { function: { name: "submit_solution", arguments: "{}" } },
              ],
            },
          },
        ],
      }),
    ),
  );
  const { dispatch } = buildDispatch(capabilities, "http://127.0.0.1:9/v1/chat/completions");
  const adapter = createOneShotAdapter({
    capabilities,
    approved: true,
    approvedProviderWireRequestObjectDigest: envelopeDigest(dispatch.wireRequest),
    authorization: "Bearer sealed",
    fetchImpl: multi.fetchImpl,
    now: () => TS,
  });
  const multiResult = await adapter.completeOnce(dispatch, new AbortController().signal);
  expect(multi.hits()).toBe(1);
  expect(multiResult.state).toBe("completed");
  if (multiResult.state === "completed") {
    expect(multiResult.receipt.outcome).toBe("FAILED");
    if (multiResult.receipt.outcome === "FAILED") {
      expect(multiResult.receipt.error.code).toBe("MODEL_PROTOCOL_ERROR");
    }
  }
  const malformed = countingFetch(() =>
    jsonResponse(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [{ function: { name: "request_context", arguments: "{not-json" } }],
            },
          },
        ],
      }),
    ),
  );
  const malformedAdapter = createOneShotAdapter({
    capabilities,
    approved: true,
    approvedProviderWireRequestObjectDigest: envelopeDigest(dispatch.wireRequest),
    authorization: "Bearer sealed",
    fetchImpl: malformed.fetchImpl,
    now: () => TS,
  });
  const malformedResult = await malformedAdapter.completeOnce(
    dispatch,
    new AbortController().signal,
  );
  expect(malformed.hits()).toBe(1);
  expect(malformedResult.state).toBe("completed");
  if (malformedResult.state === "completed" && malformedResult.receipt.outcome === "FAILED") {
    expect(malformedResult.receipt.error.code).toBe("MODEL_PROTOCOL_ERROR");
  }
});

test("Grade C ambiguous disconnect is outcome-unknown and is not replayed", async () => {
  const capabilities = openaiCapabilities();
  const http = countingFetch(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"choices":[{"delta":{"tool_calls":[{'),
            );
            controller.error(new Error("drop"));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  );
  const { dispatch } = buildDispatch(capabilities, "http://127.0.0.1:9/v1/chat/completions");
  const adapter = createOneShotAdapter({
    capabilities,
    approved: true,
    approvedProviderWireRequestObjectDigest: envelopeDigest(dispatch.wireRequest),
    authorization: "Bearer sealed",
    fetchImpl: http.fetchImpl,
    now: () => TS,
  });
  const result = await adapter.completeOnce(dispatch, new AbortController().signal);
  expect(http.hits()).toBe(1);
  expect(result.state).toBe("accepted-outcome-unknown");
  if (result.state === "accepted-outcome-unknown") {
    expect(result.availableLookupKeys).toEqual([]);
  }
});

test("429 with maxRetries 0 does not issue a second provider completion", async () => {
  const capabilities = openaiCapabilities();
  const http = countingFetch(() => jsonResponse("rate limited", 429));
  const { dispatch } = buildDispatch(capabilities, "http://127.0.0.1:9/v1/chat/completions");
  const adapter = createOneShotAdapter({
    capabilities,
    approved: true,
    approvedProviderWireRequestObjectDigest: envelopeDigest(dispatch.wireRequest),
    authorization: "Bearer sealed",
    fetchImpl: http.fetchImpl,
    now: () => TS,
  });
  const result = await adapter.completeOnce(dispatch, new AbortController().signal);
  expect(http.hits()).toBe(1);
  expect(result.state).toBe("not-dispatched");
});

test("credential inject cannot change body digest, endpoint, model, tools, or idempotency key", () => {
  const capabilities = openaiCapabilities();
  const { dispatch, body } = buildDispatch(capabilities, "http://127.0.0.1:9/v1/chat/completions");
  const before = {
    bodyDigest: objectDigestFromBytes(body),
    endpoint: dispatch.wireRequest.payload.endpointIdentity,
    model: dispatch.wireRequest.payload.modelRevision,
    idempotency: dispatch.wireRequest.payload.providerIdempotencyKey,
    tools: bodyField(body, "tools"),
  };
  const injected = injectSealedAuthorization({
    wire: dispatch.wireRequest.payload,
    body,
    approved: true,
    approvedProviderWireRequestObjectDigest: envelopeDigest(dispatch.wireRequest),
    wireEnvelopeObjectDigest: envelopeDigest(dispatch.wireRequest),
    authorization: "Bearer sealed",
  });
  if (injected.kind === "not-approved") {
    throw new Error("expected inject");
  }
  expect(objectDigestFromBytes(injected.body)).toBe(before.bodyDigest);
  expect(injected.endpointIdentity).toBe(before.endpoint);
  expect(injected.modelRevision).toBe(before.model);
  expect(injected.providerIdempotencyKey).toBe(before.idempotency);
  expect(bodyField(injected.body, "tools")).toEqual(before.tools);
  expect(injected.headers.authorization).toBe("Bearer sealed");
});

test("approval missing adds no Authorization header and performs no socket write", async () => {
  const capabilities = openaiCapabilities();
  const http = countingFetch(() => jsonResponse(openaiToolResponse()));
  const { dispatch, body } = buildDispatch(capabilities, "http://127.0.0.1:9/v1/chat/completions");
  const denied = injectSealedAuthorization({
    wire: dispatch.wireRequest.payload,
    body,
    approved: false,
    approvedProviderWireRequestObjectDigest: envelopeDigest(dispatch.wireRequest),
    wireEnvelopeObjectDigest: envelopeDigest(dispatch.wireRequest),
    authorization: "Bearer sealed",
  });
  expect(denied.kind).toBe("not-approved");
  const adapter = createOneShotAdapter({
    capabilities,
    approved: false,
    approvedProviderWireRequestObjectDigest: envelopeDigest(dispatch.wireRequest),
    authorization: "Bearer sealed",
    fetchImpl: http.fetchImpl,
    now: () => TS,
  });
  const result = await adapter.completeOnce(dispatch, new AbortController().signal);
  expect(http.hits()).toBe(0);
  expect(http.authorization()).toBeNull();
  expect(result.state).toBe("not-dispatched");
});

test("Task 23 Grade C fixtures drive adapters and OpenAI-shaped JSON stays unknown", async () => {
  const records = loadCloudCapabilityRecords();
  expect(records).toHaveLength(2);
  const openai = openaiCapabilities();
  const second = secondCapabilities();
  expect(openai.recovery.grade).toBe("C");
  expect(openai.tools.supported).toBe("unknown");
  expect(openai.structuredOutput.jsonSchema).toBe("unknown");
  expect(second.recovery.grade).toBe("C");
  const openaiHttp = countingFetch(() => jsonResponse(openaiToolResponse()));
  const openaiDispatch = buildDispatch(openai, "http://127.0.0.1:9/v1/chat/completions");
  const openaiAdapter = createOneShotAdapter({
    capabilities: openai,
    approved: true,
    approvedProviderWireRequestObjectDigest: envelopeDigest(openaiDispatch.dispatch.wireRequest),
    authorization: "Bearer sealed",
    fetchImpl: openaiHttp.fetchImpl,
    now: () => TS,
  });
  expect(openaiAdapter.recovery.grade).toBe("C");
  expect(openaiAdapter.recovery.lookupKeys).toEqual([]);
  const openaiResult = await openaiAdapter.completeOnce(
    openaiDispatch.dispatch,
    new AbortController().signal,
  );
  expect(openaiHttp.hits()).toBe(1);
  expect(openaiResult.state).toBe("completed");
  const secondHttp = countingFetch(() => jsonResponse(anthropicToolResponse()));
  const secondDispatch = buildDispatch(second, "http://127.0.0.1:9/v1/messages");
  const secondAdapter = createOneShotAdapter({
    capabilities: second,
    approved: true,
    approvedProviderWireRequestObjectDigest: envelopeDigest(secondDispatch.dispatch.wireRequest),
    authorization: "Bearer sealed",
    fetchImpl: secondHttp.fetchImpl,
    now: () => TS,
  });
  expect(secondAdapter.recovery.grade).toBe("C");
  const secondResult = await secondAdapter.completeOnce(
    secondDispatch.dispatch,
    new AbortController().signal,
  );
  expect(secondHttp.hits()).toBe(1);
  expect(secondResult.state).toBe("completed");
  const gradeA = recoveryAdapterFor({
    ...openai,
    recovery: {
      grade: "A",
      idempotencyKey: true,
      resultLookup: true,
      lookupKeyKinds: ["request-object", "provider-idempotency-key"],
      serverCancellation: false,
    },
  });
  expect(gradeA.grade).toBe("A");
  if (gradeA.grade === "A") {
    const looked = await gradeA.lookup(
      { kind: "request-object", requestEnvelopeObjectDigest: openai.adapterVersionObjectDigest },
      new AbortController().signal,
    );
    expect(looked.state).toBe("unknown");
  }
});

test("wire-body token over-count returns WAITING capacity with zero HTTP calls", () => {
  const capabilities = {
    ...openaiCapabilities(),
    context: { nativeTokens: 8, extendedTokens: null, maxOutputTokens: 4 },
  };
  const http = countingFetch(() => jsonResponse(openaiToolResponse()));
  const { request, conversation, egress } = buildDispatch(
    openaiCapabilities(),
    "http://127.0.0.1:9/v1/chat/completions",
  );
  const built = buildProviderWireRequest({
    request,
    conversation,
    egress,
    capabilities,
    tokenization: tokenization({ reservedOutputTokens: 4 }),
  });
  expect(built.kind).toBe("waiting");
  if (built.kind === "waiting") {
    expect(built.state).toMatch(/^WAITING_/);
  }
  expect(http.hits()).toBe(0);
  const body = providerBodyBytes(conversation.payload, request.payload, capabilities);
  expect(body.byteLength).toBeGreaterThan(8);
});

test("partial SSE truncated at byte boundaries never duplicates a completion", async () => {
  const capabilities = openaiCapabilities();
  const sse = `data: ${openaiToolResponse()}\n\ndata: [DONE]\n\n`;
  const bytes = Buffer.from(sse, "utf8");
  for (let end = 1; end < bytes.byteLength; end += Math.max(1, Math.floor(bytes.byteLength / 8))) {
    const slice = bytes.subarray(0, end);
    const http = countingFetch(
      () =>
        new Response(slice, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const { dispatch } = buildDispatch(capabilities, "http://127.0.0.1:9/v1/chat/completions");
    const adapter = createOneShotAdapter({
      capabilities,
      approved: true,
      approvedProviderWireRequestObjectDigest: envelopeDigest(dispatch.wireRequest),
      authorization: "Bearer sealed",
      fetchImpl: http.fetchImpl,
      now: () => TS,
    });
    const result = await adapter.completeOnce(dispatch, new AbortController().signal);
    expect(http.hits()).toBe(1);
    if (result.state === "completed" && result.receipt.outcome === "VALID_RESULT") {
      continue;
    }
    expect(result.state === "accepted-outcome-unknown" || result.state === "completed").toBe(true);
  }
});

test("router may switch deployment only before dispatch and never by price", () => {
  const openai = openaiCapabilities();
  const second = secondCapabilities();
  const selected = selectDeploymentBeforeDispatch({
    userOrder: [openai.deploymentId, second.deploymentId],
    records: [openai, second],
    requiredNativeTokens: 150000,
    requiredMaxOutputTokens: 100,
    dispatched: false,
  });
  expect(selected?.deploymentId).toBe(second.deploymentId);
  const afterDispatch = selectDeploymentBeforeDispatch({
    userOrder: [second.deploymentId],
    records: [openai, second],
    requiredNativeTokens: 1,
    requiredMaxOutputTokens: 1,
    dispatched: true,
  });
  expect(afterDispatch).toBeUndefined();
});

test("wrong approved wire digest performs no socket write", async () => {
  const capabilities = openaiCapabilities();
  const http = countingFetch(() => jsonResponse(openaiToolResponse()));
  const { dispatch } = buildDispatch(capabilities, "http://127.0.0.1:9/v1/chat/completions");
  const adapter = createOneShotAdapter({
    capabilities,
    approved: true,
    approvedProviderWireRequestObjectDigest: objectDigestFromBytes(
      Buffer.from("wrong-wire-approval", "utf8"),
    ),
    authorization: "Bearer sealed",
    fetchImpl: http.fetchImpl,
    now: () => TS,
  });
  const result = await adapter.completeOnce(dispatch, new AbortController().signal);
  expect(http.hits()).toBe(0);
  expect(http.authorization()).toBeNull();
  expect(result.state).toBe("not-dispatched");
});

test("sealed inputTokens below counted body waits with zero HTTP even when nativeTokens fit", () => {
  const capabilities = openaiCapabilities();
  const http = countingFetch(() => jsonResponse(openaiToolResponse()));
  const { request, conversation, egress } = buildDispatch(
    capabilities,
    "http://127.0.0.1:9/v1/chat/completions",
  );
  const body = providerBodyBytes(conversation.payload, request.payload, capabilities);
  const counted = countCloudTokens(
    Buffer.from(body).toString("utf8"),
    PI_HEC_CLOUD_TOKENIZER_REVISION,
  );
  if (counted === undefined) {
    throw new Error("tokenizer revision did not count the provider body");
  }
  expect(counted).toBeGreaterThan(1);
  const built = buildProviderWireRequest({
    request,
    conversation,
    egress,
    capabilities,
    tokenization: tokenization({ inputTokens: counted - 1, reservedOutputTokens: 16 }),
  });
  expect(built.kind).toBe("waiting");
  if (built.kind === "waiting") {
    expect(built.state).toMatch(/^WAITING_/);
  }
  expect(http.hits()).toBe(0);
});

test("abort after the provider accepted the request is outcome-unknown and is not retried", async () => {
  const capabilities = openaiCapabilities();
  const http = countingFetch(() => {
    throw Object.assign(new Error("reset after accept"), { name: "AbortError" });
  });
  const { dispatch } = buildDispatch(capabilities, "http://127.0.0.1:9/v1/chat/completions");
  const adapter = createOneShotAdapter({
    capabilities,
    approved: true,
    approvedProviderWireRequestObjectDigest: envelopeDigest(dispatch.wireRequest),
    authorization: "Bearer sealed",
    fetchImpl: http.fetchImpl,
    now: () => TS,
  });
  const result = await adapter.completeOnce(dispatch, new AbortController().signal);
  expect(http.hits()).toBe(1);
  expect(result.state).toBe("accepted-outcome-unknown");
});

test("re-hash mismatch of sealed bindings does not inject credentials or write the socket", async () => {
  const capabilities = openaiCapabilities();
  const http = countingFetch(() => jsonResponse(openaiToolResponse()));
  const { dispatch } = buildDispatch(capabilities, "http://127.0.0.1:9/v1/chat/completions");
  const tampered = {
    ...dispatch,
    wireRequest: {
      ...dispatch.wireRequest,
      payload: {
        ...dispatch.wireRequest.payload,
        bodyObjectDigest: sha256Utf8("tampered-body"),
      },
    },
  };
  const adapter = createOneShotAdapter({
    capabilities,
    approved: true,
    approvedProviderWireRequestObjectDigest: envelopeDigest(dispatch.wireRequest),
    authorization: "Bearer sealed",
    fetchImpl: http.fetchImpl,
    now: () => TS,
  });
  const result = await adapter.completeOnce(tampered, new AbortController().signal);
  expect(http.hits()).toBe(0);
  expect(http.authorization()).toBeNull();
  expect(result.state).toBe("not-dispatched");
});

test("Grade B does not advertise a fake provider-operation-id", async () => {
  const capabilities = {
    ...openaiCapabilities(),
    recovery: {
      grade: "B" as const,
      idempotencyKey: false,
      resultLookup: true as const,
      lookupKeyKinds: ["provider-operation-id"] as ["provider-operation-id"],
      serverCancellation: false,
    },
  };
  const http = countingFetch(() => {
    throw Object.assign(new Error("drop after write"), { name: "AbortError" });
  });
  const { dispatch } = buildDispatch(
    openaiCapabilities(),
    "http://127.0.0.1:9/v1/chat/completions",
  );
  const adapter = createOneShotAdapter({
    capabilities,
    approved: true,
    approvedProviderWireRequestObjectDigest: envelopeDigest(dispatch.wireRequest),
    authorization: "Bearer sealed",
    fetchImpl: http.fetchImpl,
    now: () => TS,
  });
  const result = await adapter.completeOnce(dispatch, new AbortController().signal);
  expect(http.hits()).toBe(1);
  expect(result.state).toBe("accepted-outcome-unknown");
  if (result.state === "accepted-outcome-unknown") {
    expect(result.availableLookupKeys).toEqual([]);
  }
});
