import { ReadableStream } from "node:stream/web";
import { expect, test } from "vitest";
import { objectDigestFromBytes, type ObjectDigest } from "@pi-hec/contracts";
import type { BlobStore, PutObjectInput, PutObjectResult } from "@pi-hec/cas";
import { createOneShotAdapter, envelopeDigest } from "@pi-hec/cloud-gateway";
import type { RunId } from "@pi-hec/domain";
import {
  bootstrapTrustedWorld,
  createTaskRun,
  openTempStore,
  HOST_SIGNER,
  NOW,
} from "../../../packages/state-store/test/helpers.js";
import { loadUsageLedger, uniqueLeaves } from "@pi-hec/usage";
import {
  artifactInputFromPutResult,
  dispatchCloudCall,
  persistDispatchBytes,
} from "../src/services/cloud-dispatch.js";
import {
  TS,
  buildDispatch,
  countingFetch,
  jsonResponse,
  openaiCapabilities,
  openaiToolResponse,
} from "../../../packages/cloud-gateway/test/helpers.js";

class RecordingCas implements BlobStore {
  readonly order: ObjectDigest[] = [];
  readonly objects = new Map<string, Uint8Array>();
  completeObserved = false;
  receiptBeforeComplete = false;
  #nonce = 0;

  objectPath(): string {
    return "memory";
  }

  async getObject(input: { objectDigest: ObjectDigest }): Promise<Uint8Array> {
    const found = this.objects.get(input.objectDigest);
    if (found === undefined) {
      throw new Error("missing");
    }
    return found;
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const objectDigest = objectDigestFromBytes(input.bytes);
    this.order.push(objectDigest);
    this.objects.set(objectDigest, input.bytes);
    if (input.schemaName === "CloudCompletionReceipt") {
      this.receiptBeforeComplete = !this.completeObserved;
    }
    this.#nonce += 1;
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(this.#nonce, 8);
    return {
      objectDigest,
      storageRecord: {
        schemaVersion: 1,
        projectId: input.projectId,
        objectDigest,
        mediaType: input.mediaType,
        plaintextByteSize: input.bytes.byteLength,
        classification: input.classification,
        encryptionAlgorithm: "AES-256-GCM",
        encryptionKeyId: "test-dek-1",
        encryptionNonceBase64: nonce.toString("base64"),
        createdAt: NOW,
      },
      storageRecordDigest: objectDigest,
      reusedExisting: false,
    };
  }

  markComplete(): void {
    this.completeObserved = true;
  }
}

async function seedContextPacket(
  cas: RecordingCas,
  store: ReturnType<typeof openTempStore>["store"],
  scope: ReturnType<typeof bootstrapTrustedWorld>["projectScope"],
  projectId: string,
  digestLabelBytes: Uint8Array,
): Promise<ObjectDigest> {
  return persistDispatchBytes({
    cas,
    store,
    scope,
    projectId,
    bytes: digestLabelBytes,
    schemaName: "ContextPacket",
    now: NOW,
    hostSignerDigest: HOST_SIGNER,
  });
}

async function runDispatch(input: {
  handler: () => Response;
  projectId: string;
  runId?: string;
}) {
  const opened = openTempStore();
  const world = bootstrapTrustedWorld(opened.store, input.projectId);
  createTaskRun(opened.store, world, (input.runId ?? "run_01234567-89ab-7cde-8f01-23456789abcd") as RunId);
  const capabilities = openaiCapabilities();
  const http = countingFetch(input.handler);
  const { dispatch } = buildDispatch(capabilities, "http://127.0.0.1:9/v1/chat/completions");
  const cas = new RecordingCas();
  const contextPacketDigest = await seedContextPacket(
    cas,
    opened.store,
    world.projectScope,
    world.projectId,
    Buffer.from("zero-digest", "utf8"),
  );
  const adapter = createOneShotAdapter({
    capabilities,
    approved: true,
    approvedProviderWireRequestObjectDigest: envelopeDigest(dispatch.wireRequest),
    authorization: "Bearer sealed",
    fetchImpl: http.fetchImpl,
    now: () => TS,
    putBytes: (bytes) =>
      persistDispatchBytes({
        cas,
        store: opened.store,
        scope: world.projectScope,
        projectId: world.projectId,
        bytes,
        schemaName: null,
        now: NOW,
        hostSignerDigest: HOST_SIGNER,
      }),
  });
  return { opened, world, dispatch, adapter, cas, http, contextPacketDigest };
}

test("second dispatchCloudCall on the same prepared envelope returns already-owned and does not complete twice", async () => {
  const harness = await runDispatch({
    handler: () => jsonResponse(openaiToolResponse()),
    projectId: "proj-cloud-15",
  });
  try {
    const first = await dispatchCloudCall({
      store: harness.opened.store,
      cas: harness.cas,
      scope: harness.world.projectScope,
      projectId: harness.world.projectId,
      dispatch: harness.dispatch,
      adapter: harness.adapter,
      contextPacketDigest: harness.contextPacketDigest,
      hostSignerDigest: HOST_SIGNER,
      now: NOW,
      signal: new AbortController().signal,
    });
    expect(first.kind).toBe("completed");
    expect(harness.http.hits()).toBe(1);
    const second = await dispatchCloudCall({
      store: harness.opened.store,
      cas: harness.cas,
      scope: harness.world.projectScope,
      projectId: harness.world.projectId,
      dispatch: harness.dispatch,
      adapter: harness.adapter,
      contextPacketDigest: harness.contextPacketDigest,
      hostSignerDigest: HOST_SIGNER,
      now: NOW,
      signal: new AbortController().signal,
    });
    expect(second.kind).toBe("already-owned");
    expect(harness.http.hits()).toBe(1);
    const row = harness.opened.store.getCloudCall(
      harness.world.projectScope,
      harness.dispatch.request.payload.cloudCallId,
    );
    expect(row?.state).toBe("completed");
  } finally {
    harness.opened.close();
  }
});

test("one accepted completion persists one usage leaf from the receipt", async () => {
  const harness = await runDispatch({
    handler: () => jsonResponse(openaiToolResponse()),
    projectId: "proj-cloud-usage-22",
  });
  try {
    const result = await dispatchCloudCall({
      store: harness.opened.store,
      cas: harness.cas,
      scope: harness.world.projectScope,
      projectId: harness.world.projectId,
      dispatch: harness.dispatch,
      adapter: harness.adapter,
      contextPacketDigest: harness.contextPacketDigest,
      hostSignerDigest: HOST_SIGNER,
      now: NOW,
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("completed");
    const ledger = loadUsageLedger(harness.opened.store, harness.world.projectScope);
    const leaves = uniqueLeaves(ledger.entries);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.cloudCallId).toBe(harness.dispatch.request.payload.cloudCallId);
    if (result.kind === "completed") {
      expect(leaves[0]?.complete).toBe(result.receipt.usage.complete);
      expect(leaves[0]?.inputTokens).toBe(result.receipt.usage.inputTokens);
      expect(leaves[0]?.outputTokens).toBe(result.receipt.usage.outputTokens);
    }
  } finally {
    harness.opened.close();
  }
});

test("receipt CAS digest exists before cloud_calls.state becomes completed", async () => {
  const harness = await runDispatch({
    handler: () => jsonResponse(openaiToolResponse()),
    projectId: "proj-cloud-16",
  });
  try {
    const originalComplete = harness.opened.store.completeCloudCall.bind(harness.opened.store);
    harness.opened.store.completeCloudCall = (scope, input) => {
      harness.cas.markComplete();
      expect(harness.cas.objects.size).toBeGreaterThan(0);
      expect([...harness.cas.objects.keys()].some((digest) => harness.cas.order.includes(digest as ObjectDigest))).toBe(
        true,
      );
      originalComplete(scope, input);
    };
    const result = await dispatchCloudCall({
      store: harness.opened.store,
      cas: harness.cas,
      scope: harness.world.projectScope,
      projectId: harness.world.projectId,
      dispatch: harness.dispatch,
      adapter: harness.adapter,
      contextPacketDigest: harness.contextPacketDigest,
      hostSignerDigest: HOST_SIGNER,
      now: NOW,
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("completed");
    expect(harness.cas.receiptBeforeComplete).toBe(true);
    const row = harness.opened.store.getCloudCall(
      harness.world.projectScope,
      harness.dispatch.request.payload.cloudCallId,
    );
    expect(row?.state).toBe("completed");
    expect(row?.responseDigest).toBeDefined();
    if (row?.responseDigest !== undefined) {
      expect(harness.cas.objects.has(row.responseDigest)).toBe(true);
    }
    expect(row?.recoveryGrade).toBe(harness.adapter.recovery.grade);
    if (row !== undefined) {
      expect(harness.cas.objects.has(row.requestDigest)).toBe(true);
      const artifact = harness.opened.store.getArtifact(harness.world.projectScope, row.requestDigest);
      expect(artifact?.byteSize).toBe(harness.cas.objects.get(row.requestDigest)?.byteLength);
      expect(artifact?.byteSize).not.toBe(32);
      expect(artifact?.storageRecordSignature).not.toBe("c2lnbmF0dXJl");
      expect(artifact?.encryptionNonce).not.toBe(row.requestDigest.slice(-16));
    }
  } finally {
    harness.opened.close();
  }
});

test("length completeOnce fsyncs a receipt and does not leave dispatching", async () => {
  const harness = await runDispatch({
    handler: () =>
      jsonResponse(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "partial" } }] })),
    projectId: "proj-cloud-17",
  });
  try {
    const result = await dispatchCloudCall({
      store: harness.opened.store,
      cas: harness.cas,
      scope: harness.world.projectScope,
      projectId: harness.world.projectId,
      dispatch: harness.dispatch,
      adapter: harness.adapter,
      contextPacketDigest: harness.contextPacketDigest,
      hostSignerDigest: HOST_SIGNER,
      now: NOW,
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      expect(result.receipt.outcome).toBe("INCOMPLETE");
    }
    expect(harness.http.hits()).toBe(1);
    const row = harness.opened.store.getCloudCall(
      harness.world.projectScope,
      harness.dispatch.request.payload.cloudCallId,
    );
    expect(row?.state).not.toBe("dispatching");
    expect(row?.state).toBe("completed");
    expect(row?.responseDigest).toBeDefined();
    if (row?.responseDigest !== undefined) {
      expect(harness.cas.objects.has(row.responseDigest)).toBe(true);
    }
  } finally {
    harness.opened.close();
  }
});

test("malformed JSON completeOnce fsyncs a receipt and does not leave dispatching", async () => {
  const harness = await runDispatch({
    handler: () =>
      jsonResponse(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: { tool_calls: [{ function: { name: "request_context", arguments: "{not-json" } }] },
            },
          ],
        }),
      ),
    projectId: "proj-cloud-18",
  });
  try {
    const result = await dispatchCloudCall({
      store: harness.opened.store,
      cas: harness.cas,
      scope: harness.world.projectScope,
      projectId: harness.world.projectId,
      dispatch: harness.dispatch,
      adapter: harness.adapter,
      contextPacketDigest: harness.contextPacketDigest,
      hostSignerDigest: HOST_SIGNER,
      now: NOW,
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      expect(result.receipt.outcome).toBe("FAILED");
    }
    expect(harness.http.hits()).toBe(1);
    const row = harness.opened.store.getCloudCall(
      harness.world.projectScope,
      harness.dispatch.request.payload.cloudCallId,
    );
    expect(row?.state).not.toBe("dispatching");
    expect(row?.state).toBe("completed");
    expect(row?.responseDigest).toBeDefined();
    if (row?.responseDigest !== undefined) {
      expect(harness.cas.objects.has(row.responseDigest)).toBe(true);
    }
  } finally {
    harness.opened.close();
  }
});

test("Grade C disconnect is outcome-unknown without a second HTTP call", async () => {
  const harness = await runDispatch({
    handler: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{"));
            controller.error(new Error("drop"));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    projectId: "proj-cloud-19",
  });
  try {
    const result = await dispatchCloudCall({
      store: harness.opened.store,
      cas: harness.cas,
      scope: harness.world.projectScope,
      projectId: harness.world.projectId,
      dispatch: harness.dispatch,
      adapter: harness.adapter,
      contextPacketDigest: harness.contextPacketDigest,
      hostSignerDigest: HOST_SIGNER,
      now: NOW,
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("outcome-unknown");
    expect(harness.http.hits()).toBe(1);
    const row = harness.opened.store.getCloudCall(
      harness.world.projectScope,
      harness.dispatch.request.payload.cloudCallId,
    );
    expect(row?.state).toBe("outcome-unknown");
    const second = await dispatchCloudCall({
      store: harness.opened.store,
      cas: harness.cas,
      scope: harness.world.projectScope,
      projectId: harness.world.projectId,
      dispatch: harness.dispatch,
      adapter: harness.adapter,
      contextPacketDigest: harness.contextPacketDigest,
      hostSignerDigest: HOST_SIGNER,
      now: NOW,
      signal: new AbortController().signal,
    });
    expect(second.kind).toBe("already-owned");
    expect(harness.http.hits()).toBe(1);
  } finally {
    harness.opened.close();
  }
});

test("abort after accept is outcome-unknown with a single HTTP completion", async () => {
  const harness = await runDispatch({
    handler: () => {
      throw Object.assign(new Error("reset after accept"), { name: "AbortError" });
    },
    projectId: "proj-cloud-20",
  });
  try {
    const result = await dispatchCloudCall({
      store: harness.opened.store,
      cas: harness.cas,
      scope: harness.world.projectScope,
      projectId: harness.world.projectId,
      dispatch: harness.dispatch,
      adapter: harness.adapter,
      contextPacketDigest: harness.contextPacketDigest,
      hostSignerDigest: HOST_SIGNER,
      now: NOW,
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("outcome-unknown");
    expect(harness.http.hits()).toBe(1);
    const attempts = harness.opened.store.listCloudTransportAttempts(
      harness.world.projectScope,
      harness.dispatch.request.payload.cloudCallId,
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe("accepted-outcome-unknown");
  } finally {
    harness.opened.close();
  }
});

test("proven 429 is not-dispatched and SAFE_SAME_REQUEST can re-enter without a new CloudCallId", async () => {
  const harness = await runDispatch({
    handler: () => jsonResponse("rate limited", 429),
    projectId: "proj-cloud-21",
  });
  try {
    const first = await dispatchCloudCall({
      store: harness.opened.store,
      cas: harness.cas,
      scope: harness.world.projectScope,
      projectId: harness.world.projectId,
      dispatch: harness.dispatch,
      adapter: harness.adapter,
      contextPacketDigest: harness.contextPacketDigest,
      hostSignerDigest: HOST_SIGNER,
      now: NOW,
      signal: new AbortController().signal,
    });
    expect(first.kind).toBe("not-dispatched");
    expect(harness.http.hits()).toBe(1);
    const row = harness.opened.store.getCloudCall(
      harness.world.projectScope,
      harness.dispatch.request.payload.cloudCallId,
    );
    expect(row?.state).toBe("prepared");
    const attempts = harness.opened.store.listCloudTransportAttempts(
      harness.world.projectScope,
      harness.dispatch.request.payload.cloudCallId,
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).not.toBe("accepted");
    expect(attempts[0]?.outcome).toBe("failed-before-acceptance");
    const second = await dispatchCloudCall({
      store: harness.opened.store,
      cas: harness.cas,
      scope: harness.world.projectScope,
      projectId: harness.world.projectId,
      dispatch: harness.dispatch,
      adapter: harness.adapter,
      contextPacketDigest: harness.contextPacketDigest,
      hostSignerDigest: HOST_SIGNER,
      now: NOW,
      signal: new AbortController().signal,
    });
    expect(second.kind).not.toBe("already-owned");
    expect(second.kind).toBe("not-dispatched");
    expect(harness.http.hits()).toBe(2);
    expect(
      harness.opened.store.listCloudTransportAttempts(
        harness.world.projectScope,
        harness.dispatch.request.payload.cloudCallId,
      ),
    ).toHaveLength(2);
  } finally {
    harness.opened.close();
  }
});

test("artifactInputFromPutResult copies CAS occupancy fields", () => {
  const digest = objectDigestFromBytes(Buffer.from("payload", "utf8"));
  const result: PutObjectResult = {
    objectDigest: digest,
    storageRecord: {
      schemaVersion: 1,
      projectId: "proj",
      objectDigest: digest,
      mediaType: "application/json",
      plaintextByteSize: 7,
      classification: "internal",
      encryptionAlgorithm: "AES-256-GCM",
      encryptionKeyId: "dek",
      encryptionNonceBase64: "AAAAAAAAAAAA",
      createdAt: NOW,
    },
    storageRecordDigest: digest,
    reusedExisting: false,
  };
  const artifact = artifactInputFromPutResult(result, "CanonicalCloudRequest", NOW, HOST_SIGNER);
  expect(artifact.byteSize).toBe(7);
  expect(artifact.encryptionNonce).toBe("AAAAAAAAAAAA");
  expect(artifact.storageRecordSignature).not.toBe("c2lnbmF0dXJl");
});
