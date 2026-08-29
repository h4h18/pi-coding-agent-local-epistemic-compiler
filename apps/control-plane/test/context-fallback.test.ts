import { expect, test } from "vitest";
import {
  sha256Utf8,
  type CloudCallId,
  type ContextRequest,
  type Digest,
  type EvidenceBundle,
  type EvidenceId,
  type ObjectDigest,
  type RunId,
  type SnapshotId,
} from "@pi-hec/contracts";
import {
  handleContextFallback,
  isUnboundedContextRequest,
} from "../src/orchestration/handlers.js";

const RUN = "run_01234567-89ab-7cde-8f01-23456789abcd" as RunId;
const CALL = "call_01234567-89ab-7cde-8f01-23456789abcd" as CloudCallId;
const NEXT_CALL = "call_01234567-89ab-7cde-8f01-23456789abce" as CloudCallId;
const SNAP = "snap_01234567-89ab-7cde-8f01-23456789abcd" as SnapshotId;
const CLAIM = ("evidence_" + "a".repeat(52)) as EvidenceId;
const PACKET = sha256Utf8("prior-packet") as ObjectDigest;
const BINDING = sha256Utf8("binding") as Digest;
const ROOT = sha256Utf8("snapshot-root");
const ANALYST_PROSE = "LOCAL_ANALYST_SAYS_THE_BUG_IS_IN_WIDGET_FACTORY_PARSE";

function request(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    schemaVersion: 1,
    runId: RUN,
    cloudCallId: CALL,
    requestBindingDigest: BINDING,
    contextPacketObjectDigest: PACKET,
    baseSnapshotId: SNAP,
    baseSnapshotRootDigest: ROOT,
    kind: "request_context",
    missingClaimIds: [CLAIM],
    requestedEvidenceKinds: ["file"],
    pathOrSymbolHints: ["src/widget.ts"],
    requestedSkillIds: [],
    reason: "need the widget parser source for missing claim",
    ...overrides,
  };
}

function bundle(): EvidenceBundle {
  return {
    id: "bundle-widget",
    purpose: "causal-path",
    nodeIds: [CLAIM],
    edgeIds: [],
    exactSourceRefs: [
      {
        origin: "repository",
        sourceKind: "repository",
        snapshotId: SNAP,
        artifactObjectDigest: PACKET,
        path: "src/widget.ts",
        range: { kind: "whole" },
        quoteDigest: ROOT,
      },
    ],
    mandatory: true,
  };
}

test("unbounded request_context is rejected", () => {
  const unbounded = request({
    reason: "send the whole repository",
    pathOrSymbolHints: ["**"],
  });
  expect(isUnboundedContextRequest(unbounded)).toBe(true);
});

test("bounded missing claim IDs produce a ContextDelta and a new CloudCallId with one completion", async () => {
  let dispatchCalls = 0;
  const result = await handleContextFallback({
    request: request(),
    priorContextPacketObjectDigest: PACKET,
    unresolvedClaimIds: [CLAIM],
    retrieve: async ({ claimIds, hints }) => {
      expect([...claimIds]).toEqual([CLAIM]);
      expect([...hints]).toEqual(["src/widget.ts"]);
      return {
        bundles: [bundle()],
        resolvedClaimIds: [CLAIM],
        stillUnresolvedClaimIds: [],
        payloadsPresent: true,
      };
    },
    compileAndDispatch: async ({ cloudCallId, contextDelta }) => {
      dispatchCalls += 1;
      expect(cloudCallId).toBe(NEXT_CALL);
      expect(contextDelta.requestedByCloudCallId).toBe(CALL);
      expect(contextDelta.resolvedClaimIds).toEqual([CLAIM]);
      expect(JSON.stringify(contextDelta).includes(ANALYST_PROSE)).toBe(false);
      return { dispatch: { kind: "waiting-provider" }, completionCount: 1 };
    },
    mintCloudCallId: () => NEXT_CALL,
  });
  expect(result.kind).toBe("follow-up");
  if (result.kind !== "follow-up") {
    throw new Error("expected follow-up");
  }
  expect(result.cloudCallId).toBe(NEXT_CALL);
  expect(result.cloudCallId).not.toBe(CALL);
  expect(result.completionCount).toBe(1);
  expect(dispatchCalls).toBe(1);
  expect(result.dispatch.kind).toBe("waiting-provider");
  expect(JSON.stringify(result.contextDelta).includes(ANALYST_PROSE)).toBe(false);
});

test("unbounded request_context does not dispatch a follow-up completion", async () => {
  let dispatchCalls = 0;
  const result = await handleContextFallback({
    request: request({ reason: "пришли весь репозиторий" }),
    priorContextPacketObjectDigest: PACKET,
    unresolvedClaimIds: [CLAIM],
    retrieve: async () => {
      throw new Error("retrieve must not run");
    },
    compileAndDispatch: async () => {
      dispatchCalls += 1;
      return { dispatch: { kind: "waiting-provider" }, completionCount: 1 };
    },
  });
  expect(result).toEqual({ kind: "unbounded-rejected", code: "UNBOUNDED_CONTEXT_REQUEST" });
  expect(dispatchCalls).toBe(0);
});
