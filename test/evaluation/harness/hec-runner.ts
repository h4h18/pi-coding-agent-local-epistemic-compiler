import { Compile } from "typebox/compile";
import {
  CloudDispatchSchema,
  ContextPacketSchema,
  sha256Utf8,
  type CloudDispatch,
  type ContextPacket,
  type ObjectDigest,
  type RunId,
  type SnapshotId,
} from "@pi-hec/contracts";
import { buildProviderWireRequest, createOneShotAdapter, unsignedEnvelope } from "@pi-hec/cloud-gateway";
import { loadCloudCapabilityRecords } from "@pi-hec/models";
import { canonicalOf, conversationOf, egressOf, openaiCapabilities, tokenization } from "../../../packages/cloud-gateway/test/helpers.js";

export const HEC_CLOUD_EXECUTOR = "createOneShotAdapter.completeOnce";
export { createOneShotAdapter };

const PACKET = Compile(ContextPacketSchema);
const DISPATCH = Compile(CloudDispatchSchema);
const ZERO = "sha256:0000000000000000000000000000000000000000000000000000000000000000" as ObjectDigest;
const RUN = "run_01234567-89ab-7cde-8f01-23456789abcd" as RunId;
const SNAP = "snap_01234567-89ab-7cde-8f01-23456789abcd" as SnapshotId;
const REQ = `req_${"a".repeat(52)}`;
const EVAL_ENDPOINT = "http://127.0.0.1:9/v1/chat/completions";

export type OneShotComplete = (
  dispatch: CloudDispatch,
  signal: AbortSignal,
) => Promise<{ readonly state: string }>;

const FORBIDDEN_HINTS = [
  "evaluation-only",
  "holdout",
  "gold patch",
  "gold-patch",
  "arm-1",
  "arm-2",
  "arm-3",
  "arm-4",
  "this is an evaluation",
];

function sourceRef(): ContextPacket["requirementLedger"]["requirements"][number]["sourceRefs"][number] {
  return {
    origin: "artifact",
    sourceKind: "user-task",
    artifactObjectDigest: ZERO,
    range: { kind: "whole" },
    quoteDigest: ZERO,
  };
}

export function buildHecPacket(prompt: string): ContextPacket {
  const request = prompt.length > 0 ? prompt : "complete the task";
  const packet: ContextPacket = {
    schemaVersion: 1,
    runId: RUN,
    snapshotId: SNAP,
    snapshotRootDigest: ZERO,
    requirementLedgerObjectDigest: ZERO,
    instructionManifestObjectDigest: ZERO,
    skillManifestObjectDigest: ZERO,
    control: {
      schemaVersion: 1,
      runId: RUN,
      role: "CLOUD_EXECUTOR",
      userScope: {
        allowedPathGlobs: ["src/**", "test/**"],
        forbiddenPathGlobs: ["secrets/**"],
        forbiddenOperations: ["symlink"],
      },
      allowedResultKinds: ["submit_solution", "request_context"],
      allowedChangeOperations: ["text_patch", "create_text", "delete"],
      forbiddenCapabilities: [
        "generic-read",
        "shell",
        "workspace-write",
        "git-mutation",
        "secret-access",
        "deployment",
      ],
      resultSchemaObjectDigest: ZERO,
      contextRequestPolicy: {
        existingUnresolvedClaimsOnly: true,
        cumulativeEgressReapproval: true,
      },
    },
    requirementLedger: {
      schemaVersion: 1,
      runId: RUN,
      originalRequest: request,
      originalRequestDigest: sha256Utf8(request),
      requirements: [
        {
          id: REQ,
          text: request,
          sourceRefs: [sourceRef()],
          priority: "MUST",
          state: "CLEAR",
          kind: "authoritative",
          source: "USER_EXPLICIT",
          normative: true,
        },
      ],
      nonGoals: [],
      conflicts: [],
      openQuestions: [],
    },
    instructionManifest: {
      schemaVersion: 1,
      snapshotId: SNAP,
      instructions: [],
    },
    skillManifest: {
      schemaVersion: 1,
      snapshotId: SNAP,
      skills: [],
      conflicts: [],
    },
    authoritativeInstructions: [],
    repositoryMap: [],
    bundles: [],
    relations: [],
    evidencePayloads: [],
    loadedSkills: [],
    verifiedFacts: [],
    unknowns: [],
    conflicts: [],
    risks: [],
    verificationCapabilities: [],
    omissionManifest: {
      omittedEvidenceRootDigest: ZERO,
      countsByReason: {
        duplicate: 0,
        "lower-utility": 0,
        untrusted: 0,
        "window-capacity": 0,
      },
      criticalOmissions: [],
    },
    tokenization: {
      deploymentId: "eval-fixture-deployment",
      inputTokens: 0,
      reservedOutputTokens: 2048,
      tokenizerRevision: "pi-hec-conservative-v1",
    },
  };
  if (!PACKET.Check(packet)) {
    throw new Error("HEC ContextPacket failed ContextPacketSchema");
  }
  return packet;
}

export function hecPacketHasEvaluationHints(packet: ContextPacket): boolean {
  const blob = JSON.stringify(packet).toLowerCase();
  return FORBIDDEN_HINTS.some((hint) => blob.includes(hint));
}

export function buildHecDispatch(): CloudDispatch {
  const records = loadCloudCapabilityRecords();
  const capabilities = records.find((item) => item.deploymentId === openaiCapabilities().deploymentId);
  if (capabilities === undefined) {
    throw new Error("missing openai-shaped-unknown fixture");
  }
  const request = unsignedEnvelope("CanonicalCloudRequest", canonicalOf(capabilities));
  const conversation = unsignedEnvelope("CompiledCloudConversation", conversationOf(capabilities));
  const egress = unsignedEnvelope("EgressManifest", egressOf(capabilities, EVAL_ENDPOINT));
  const built = buildProviderWireRequest({
    request,
    conversation,
    egress,
    capabilities,
    tokenization: tokenization(),
  });
  if (built.kind !== "wire") {
    throw new Error(`expected wire request, got ${built.kind}`);
  }
  const dispatch: CloudDispatch = { request, egress, conversation, wireRequest: built.envelope };
  if (!DISPATCH.Check(dispatch)) {
    throw new Error("HEC CloudDispatch failed CloudDispatchSchema");
  }
  return dispatch;
}

export async function runHecArm(input: {
  readonly phase: "first" | "final-repair";
  readonly completeOnce?: OneShotComplete;
  readonly adapterOptions?: Parameters<typeof createOneShotAdapter>[0];
  readonly dispatch?: CloudDispatch;
  readonly signal?: AbortSignal;
  readonly prompt?: string;
}): Promise<{
  readonly state: string;
  readonly phase: "first" | "final-repair";
  readonly packet: ContextPacket;
  readonly dispatch: CloudDispatch;
}> {
  const packet = buildHecPacket(input.prompt ?? "complete the task");
  const dispatch = input.dispatch ?? buildHecDispatch();
  if (!DISPATCH.Check(dispatch)) {
    throw new Error("HEC CloudDispatch failed CloudDispatchSchema");
  }
  const adapter =
    input.adapterOptions === undefined ? undefined : createOneShotAdapter(input.adapterOptions);
  const completeOnce =
    input.completeOnce ??
    (adapter === undefined
      ? undefined
      : (nextDispatch: CloudDispatch, signal: AbortSignal) => adapter.completeOnce(nextDispatch, signal));
  if (completeOnce === undefined) {
    throw new Error("HEC arm requires completeOnce or createOneShotAdapter options");
  }
  const result = await completeOnce(dispatch, input.signal ?? new AbortController().signal);
  return { state: result.state, phase: input.phase, packet, dispatch };
}
