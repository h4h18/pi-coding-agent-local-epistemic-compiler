import type {
  CloudCompletionReceipt,
  CloudDispatch,
  EnvelopeSignature,
  JsonValue,
  ObjectDigest,
  PayloadDigest,
} from "@pi-hec/contracts";
import { canonicalizeEnvelope, canonicalizeRfc8785 } from "@pi-hec/contracts";
import type { CloudCompletionAdapter } from "@pi-hec/models";
import type { BlobStore, PutObjectResult } from "@pi-hec/cas";
import type { ProjectScope } from "@pi-hec/domain";
import { MUTATION_PROFILE_TAG } from "@pi-hec/security";
import { StoreLookupError, type ArtifactInput, type StateStore } from "@pi-hec/state-store";
import { asObjectDigest, fsyncReceiptThenComplete } from "@pi-hec/cloud-gateway";
import {
  loadUsageLedger,
  normalizeProviderUsage,
  persistNormalizedUsage,
  uniqueLeaves,
} from "@pi-hec/usage";

export type CloudDispatchDecision =
  | { kind: "already-owned" }
  | { kind: "completed"; receipt: CloudCompletionReceipt }
  | { kind: "waiting-provider" }
  | { kind: "outcome-unknown" }
  | {
      kind: "not-dispatched";
      receipt: Extract<CloudCompletionReceipt, { outcome: "FAILED"; acceptedness: "PROVEN_NOT_ACCEPTED" }>;
    };

export type DispatchCloudCallInput = {
  store: StateStore;
  cas: BlobStore;
  scope: ProjectScope;
  projectId: string;
  dispatch: CloudDispatch;
  adapter: CloudCompletionAdapter;
  contextPacketDigest: ObjectDigest;
  hostSignerDigest: ObjectDigest;
  now: string;
  signal: AbortSignal;
};

function asPayloadDigest(value: string): PayloadDigest {
  if (!value.startsWith("sha256:")) {
    throw new Error("payload digest required");
  }
  return value as PayloadDigest;
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalizeRfc8785(JSON.parse(JSON.stringify(value)))) as JsonValue;
}

function envelopeBytes(envelope: {
  schemaName: string;
  schemaVersion: number;
  payload: unknown;
  payloadDigest: string;
  signatures: readonly EnvelopeSignature[];
}): Uint8Array {
  return Buffer.from(
    canonicalizeEnvelope({
      schemaName: envelope.schemaName,
      schemaVersion: envelope.schemaVersion,
      payload: jsonValue(envelope.payload),
      payloadDigest: asPayloadDigest(envelope.payloadDigest),
      signatures: envelope.signatures,
    }),
    "utf8",
  );
}

export function artifactInputFromPutResult(
  result: PutObjectResult,
  schemaName: string | null,
  now: string,
  hostSignerDigest: ObjectDigest,
): ArtifactInput {
  const record = result.storageRecord;
  return {
    digest: result.objectDigest,
    schemaName,
    mediaType: record.mediaType,
    byteSize: record.plaintextByteSize,
    classification: record.classification,
    encryptionAlgorithm: record.encryptionAlgorithm,
    encryptionKeyId: record.encryptionKeyId,
    encryptionNonce: record.encryptionNonceBase64,
    storageRecordDigest: result.storageRecordDigest,
    storageRecordSigningKeyId: "host-sign",
    storageRecordSignatureAlgorithm: "Ed25519",
    storageRecordSignedAt: now,
    storageRecordSignerCertificateDigest: hostSignerDigest,
    storageRecordSignature: Buffer.from(MUTATION_PROFILE_TAG).toString("base64"),
    createdAt: now,
  };
}

function putSqlArtifact(
  store: StateStore,
  scope: ProjectScope,
  result: PutObjectResult,
  schemaName: string | null,
  now: string,
  hostSignerDigest: ObjectDigest,
): void {
  if (!store.hasArtifact(scope, result.objectDigest)) {
    store.putArtifact(scope, artifactInputFromPutResult(result, schemaName, now, hostSignerDigest));
  }
}

export async function persistDispatchBytes(input: {
  cas: BlobStore;
  store: StateStore;
  scope: ProjectScope;
  projectId: string;
  bytes: Uint8Array;
  schemaName: string | null;
  now: string;
  hostSignerDigest: ObjectDigest;
}): Promise<ObjectDigest> {
  const stored = await input.cas.putObject({
    projectId: input.projectId,
    bytes: input.bytes,
    mediaType: input.schemaName === null ? "application/octet-stream" : "application/json",
    classification: "internal",
    ...(input.schemaName === null ? {} : { schemaName: input.schemaName }),
  });
  putSqlArtifact(input.store, input.scope, stored, input.schemaName, input.now, input.hostSignerDigest);
  return stored.objectDigest;
}

async function fsyncEnvelope(
  cas: BlobStore,
  store: StateStore,
  scope: ProjectScope,
  projectId: string,
  schemaName: string,
  envelope: unknown,
  now: string,
  hostSignerDigest: ObjectDigest,
): Promise<ObjectDigest> {
  const stored = await cas.putObject({
    projectId,
    bytes: envelopeBytes(envelope as Parameters<typeof envelopeBytes>[0]),
    mediaType: "application/json",
    classification: "internal",
    schemaName,
  });
  putSqlArtifact(store, scope, stored, schemaName, now, hostSignerDigest);
  return stored.objectDigest;
}

export async function persistPreparedCall(input: {
  store: StateStore;
  cas: BlobStore;
  scope: ProjectScope;
  projectId: string;
  request: CloudDispatch["request"];
  egress: CloudDispatch["egress"];
  conversation: CloudDispatch["conversation"];
  wireRequest: CloudDispatch["wireRequest"];
  contextPacketDigest: ObjectDigest;
  hostSignerDigest: ObjectDigest;
  recoveryGrade: "A" | "B" | "C";
  now: string;
}): Promise<ObjectDigest> {
  const requestDigest = await fsyncEnvelope(
    input.cas,
    input.store,
    input.scope,
    input.projectId,
    "CanonicalCloudRequest",
    input.request,
    input.now,
    input.hostSignerDigest,
  );
  const egressDigest = await fsyncEnvelope(
    input.cas,
    input.store,
    input.scope,
    input.projectId,
    "EgressManifest",
    input.egress,
    input.now,
    input.hostSignerDigest,
  );
  const conversationDigest = await fsyncEnvelope(
    input.cas,
    input.store,
    input.scope,
    input.projectId,
    "CompiledCloudConversation",
    input.conversation,
    input.now,
    input.hostSignerDigest,
  );
  const wireDigest = await fsyncEnvelope(
    input.cas,
    input.store,
    input.scope,
    input.projectId,
    "ProviderWireRequest",
    input.wireRequest,
    input.now,
    input.hostSignerDigest,
  );
  if (!input.store.hasArtifact(input.scope, input.contextPacketDigest)) {
    throw new Error("context packet artifact is required before cloud dispatch");
  }
  const existing = input.store.getCloudCall(input.scope, input.request.payload.cloudCallId);
  if (existing !== undefined) {
    return existing.requestDigest;
  }
  try {
    input.store.createCloudCall(input.scope, {
      cloudCallId: input.request.payload.cloudCallId,
      runId: input.request.payload.runId,
      purpose: input.request.payload.purpose,
      deploymentId: input.request.payload.deploymentId,
      requestDigest,
      contextPacketDigest: input.contextPacketDigest,
      recoveryGrade: input.recoveryGrade,
      state: "prepared",
      createdAt: input.now,
    });
  } catch (error) {
    if (!(error instanceof Error) || !/UNIQUE|constraint/i.test(error.message)) {
      throw error;
    }
    const raced = input.store.getCloudCall(input.scope, input.request.payload.cloudCallId);
    if (raced === undefined) {
      throw error;
    }
    return raced.requestDigest;
  }
  input.store.bindCloudCallArtifact(input.scope, {
    cloudCallId: input.request.payload.cloudCallId,
    role: "canonical-cloud-request",
    artifactDigest: requestDigest,
    createdAt: input.now,
  });
  input.store.bindCloudCallArtifact(input.scope, {
    cloudCallId: input.request.payload.cloudCallId,
    role: "egress-manifest",
    artifactDigest: egressDigest,
    createdAt: input.now,
  });
  input.store.bindCloudCallArtifact(input.scope, {
    cloudCallId: input.request.payload.cloudCallId,
    role: "compiled-conversation",
    artifactDigest: conversationDigest,
    createdAt: input.now,
  });
  input.store.bindCloudCallArtifact(input.scope, {
    cloudCallId: input.request.payload.cloudCallId,
    role: "provider-wire-request",
    artifactDigest: wireDigest,
    createdAt: input.now,
  });
  input.store.bindCloudCallArtifact(input.scope, {
    cloudCallId: input.request.payload.cloudCallId,
    role: "context-packet",
    artifactDigest: input.contextPacketDigest,
    createdAt: input.now,
  });
  return requestDigest;
}

export function casTransitionToDispatching(input: {
  store: StateStore;
  scope: ProjectScope;
  cloudCallId: string;
  requestDigest: ObjectDigest;
  now: string;
}): boolean {
  return input.store.transitionPreparedCloudCallToDispatching(input.scope, {
    cloudCallId: input.cloudCallId,
    requestDigest: input.requestDigest,
    attemptId: `att_${input.cloudCallId}_pending`,
    requestStartedAt: input.now,
    updatedAt: input.now,
  });
}

function persistReceiptUsage(
  input: DispatchCloudCallInput,
  receipt: CloudCompletionReceipt,
  receiptDigest: ObjectDigest,
): void {
  const usageEntryId = `usage_${receiptDigest}`;
  try {
    input.store.getUsage(input.scope, usageEntryId);
    return;
  } catch (error) {
    if (!(error instanceof StoreLookupError)) {
      throw error;
    }
  }
  const prior = uniqueLeaves(loadUsageLedger(input.store, input.scope).entries).find(
    (row) => row.cloudCallId === receipt.cloudCallId,
  );
  persistNormalizedUsage(input.store, input.scope, {
    usageEntryId,
    cloudCallId: receipt.cloudCallId,
    createdAt: input.now,
    usage: normalizeProviderUsage(receipt.usage),
    ...(prior === undefined ? {} : { correctionOf: prior.usageEntryId }),
  });
}

async function persistReceipt(
  input: DispatchCloudCallInput,
  receipt: CloudCompletionReceipt,
  bindReceipt: boolean,
): Promise<ObjectDigest> {
  const digest = await fsyncReceiptThenComplete({
    receipt,
    cas: {
      fsync: async (bytes) => {
        const stored = await input.cas.putObject({
          projectId: input.projectId,
          bytes,
          mediaType: "application/json",
          classification: "internal",
          schemaName: "CloudCompletionReceipt",
          securityCritical: true,
        });
        putSqlArtifact(
          input.store,
          input.scope,
          stored,
          "CloudCompletionReceipt",
          input.now,
          input.hostSignerDigest,
        );
        return stored.objectDigest;
      },
    },
    complete: {
      complete: (responseDigest) => {
        if (bindReceipt) {
          input.store.bindCloudCallArtifact(input.scope, {
            cloudCallId: input.dispatch.request.payload.cloudCallId,
            role: "cloud-completion-receipt",
            artifactDigest: responseDigest,
            createdAt: input.now,
          });
        }
      },
    },
  });
  persistReceiptUsage(input, receipt, digest);
  return digest;
}

export async function dispatchCloudCall(input: DispatchCloudCallInput): Promise<CloudDispatchDecision> {
  const requestDigest = await persistPreparedCall({
    store: input.store,
    cas: input.cas,
    scope: input.scope,
    projectId: input.projectId,
    request: input.dispatch.request,
    egress: input.dispatch.egress,
    conversation: input.dispatch.conversation,
    wireRequest: input.dispatch.wireRequest,
    contextPacketDigest: input.contextPacketDigest,
    hostSignerDigest: input.hostSignerDigest,
    recoveryGrade: input.adapter.recovery.grade,
    now: input.now,
  });
  const owned = casTransitionToDispatching({
    store: input.store,
    scope: input.scope,
    cloudCallId: input.dispatch.request.payload.cloudCallId,
    requestDigest,
    now: input.now,
  });
  if (!owned) {
    return { kind: "already-owned" };
  }
  const cloudCallId = input.dispatch.request.payload.cloudCallId;
  const result = await input.adapter.completeOnce(input.dispatch, input.signal);
  switch (result.state) {
    case "completed": {
      const responseDigest = await persistReceipt(input, result.receipt, true);
      input.store.completeCloudCall(input.scope, {
        cloudCallId,
        responseDigest,
        updatedAt: input.now,
      });
      input.store.recordCloudTransportAttempt(input.scope, {
        cloudCallId,
        requestStartedAt: input.now,
        outcome: "completed",
        completedAt: input.now,
      });
      return { kind: "completed", receipt: result.receipt };
    }
    case "not-dispatched": {
      await persistReceipt(input, result.receipt, false);
      input.store.settleCloudCallTransport(input.scope, {
        cloudCallId,
        requestStartedAt: input.now,
        updatedAt: input.now,
        attemptOutcome: "failed-before-acceptance",
        nextState: "prepared",
      });
      return { kind: "not-dispatched", receipt: result.receipt };
    }
    case "accepted-outcome-unknown": {
      const evidenceDigest = asObjectDigest(result.transportEvidenceObjectDigest);
      if (!input.store.hasArtifact(input.scope, evidenceDigest)) {
        throw new Error("transport evidence must be persisted to CAS before outcome-unknown");
      }
      input.store.bindCloudCallArtifact(input.scope, {
        cloudCallId,
        role: "transport-evidence",
        artifactDigest: evidenceDigest,
        createdAt: input.now,
      });
      input.store.settleCloudCallTransport(input.scope, {
        cloudCallId,
        requestStartedAt: input.now,
        updatedAt: input.now,
        attemptOutcome: "accepted-outcome-unknown",
        nextState: "outcome-unknown",
      });
      return { kind: "outcome-unknown" };
    }
    default: {
      const exhaustive: never = result;
      throw new Error(`unhandled dispatch result ${String(exhaustive)}`);
    }
  }
}
