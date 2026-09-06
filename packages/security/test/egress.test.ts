import { expect, test } from "vitest";
import type { ObjectDigest, RunId, SnapshotId, SourceRef } from "@pi-hec/contracts";
import { buildEgressManifest } from "../src/egress.js";

const ZERO = ("sha256:" + "00".repeat(32)) as ObjectDigest;
const RUN = "run_01234567-89ab-7cde-8f01-23456789abcd" as RunId;
const SNAP = "snap_01234567-89ab-7cde-8f01-23456789abcd" as SnapshotId;

const REF: SourceRef = {
  origin: "repository",
  sourceKind: "repository",
  snapshotId: SNAP,
  artifactObjectDigest: ZERO,
  path: "src/parse.ts",
  range: { kind: "whole" },
  quoteDigest: ZERO,
};

function provider() {
  return {
    deploymentId: "cloud-exec-1",
    adapterVersionObjectDigest: ZERO,
    endpointIdentity: "https://cloud.example.test/v1",
    providerChain: ["example-cloud"],
    modelRevision: "example-model-1",
    retentionPolicyObjectDigest: ZERO,
  };
}

test("restricted conversation bytes block egress with WAITING_CLOUD_ELIGIBILITY", () => {
  const outcome = buildEgressManifest({
    runId: RUN,
    snapshotId: SNAP,
    contextPacketObjectDigest: ZERO,
    compiledConversationObjectDigest: ZERO,
    conversationBytes: Buffer.from('const key = "AKIA0000000000000001";', "utf8"),
    sourceRefs: [REF],
    provider: provider(),
    policy: {
      projectClassification: "internal",
      permittedEgressClassifications: ["public", "internal", "confidential"],
      explicitApproval: true,
      contractualRetention: true,
      noEgressCloudRoleAvailable: false,
    },
    expiresAt: "2026-08-28T01:00:00.000Z",
  });
  expect(outcome.kind).toBe("waiting");
  if (outcome.kind !== "waiting") {
    return;
  }
  expect(outcome.state).toBe("WAITING_CLOUD_ELIGIBILITY");
  expect(outcome.reason.includes("AKIA0000000000000001")).toBe(false);
});

test("restricted bytes resume compile when a no-egress executor is available", () => {
  const outcome = buildEgressManifest({
    runId: RUN,
    snapshotId: SNAP,
    contextPacketObjectDigest: ZERO,
    compiledConversationObjectDigest: ZERO,
    conversationBytes: Buffer.from('const key = "AKIA0000000000000001";', "utf8"),
    sourceRefs: [REF],
    provider: {
      ...provider(),
      endpointIdentity: "https://executor.internal.test/v1",
      providerChain: ["private-no-egress"],
    },
    policy: {
      projectClassification: "internal",
      permittedEgressClassifications: ["public", "internal", "confidential"],
      explicitApproval: true,
      contractualRetention: true,
      noEgressCloudRoleAvailable: true,
    },
    expiresAt: "2026-08-28T01:00:00.000Z",
  });
  expect(outcome.kind).toBe("manifest");
  if (outcome.kind !== "manifest") {
    return;
  }
  expect(outcome.manifest.classification).not.toBe("restricted");
  expect(outcome.manifest.classification).toBe("internal");
  expect(outcome.manifest.providerChain).toEqual(["private-no-egress"]);
  expect(outcome.manifest.endpointIdentity).toBe("https://executor.internal.test/v1");
});

test("restricted bytes still cannot go to a public SaaS chain even with no-egress flag", () => {
  const outcome = buildEgressManifest({
    runId: RUN,
    snapshotId: SNAP,
    contextPacketObjectDigest: ZERO,
    compiledConversationObjectDigest: ZERO,
    conversationBytes: Buffer.from('const key = "AKIA0000000000000001";', "utf8"),
    sourceRefs: [REF],
    provider: {
      ...provider(),
      endpointIdentity: "https://api.openai.com/v1",
      providerChain: ["openai"],
    },
    policy: {
      projectClassification: "internal",
      permittedEgressClassifications: ["public", "internal", "confidential"],
      explicitApproval: true,
      contractualRetention: true,
      noEgressCloudRoleAvailable: true,
    },
    expiresAt: "2026-08-28T01:00:00.000Z",
  });
  expect(outcome.kind).toBe("waiting");
  if (outcome.kind !== "waiting") {
    return;
  }
  expect(outcome.state).toBe("WAITING_CLOUD_ELIGIBILITY");
});

test("passed DLP findings appear on a successful egress manifest", () => {
  const marker = "«REDACTED:email:aaaaaaaaaaaaaaaa»";
  const outcome = buildEgressManifest({
    runId: RUN,
    snapshotId: SNAP,
    contextPacketObjectDigest: ZERO,
    compiledConversationObjectDigest: ZERO,
    conversationBytes: Buffer.from("contact redacted", "utf8"),
    sourceRefs: [REF],
    dlpFindings: [
      {
        findingType: "email",
        classification: "confidential",
        start: 8,
        end: 36,
        marker,
        redactionPermitted: true,
        path: "src/parse.ts",
      },
    ],
    provider: provider(),
    policy: {
      projectClassification: "internal",
      permittedEgressClassifications: ["public", "internal", "confidential"],
      explicitApproval: true,
      contractualRetention: true,
      noEgressCloudRoleAvailable: false,
    },
    expiresAt: "2026-08-28T01:00:00.000Z",
  });
  expect(outcome.kind).toBe("manifest");
  if (outcome.kind !== "manifest") {
    return;
  }
  expect(
    outcome.manifest.redactions.some(
      (item) => item.marker === marker && item.findingType === "email",
    ),
  ).toBe(true);
});

test("dispatchable manifest never carries restricted classification", () => {
  const outcome = buildEgressManifest({
    runId: RUN,
    snapshotId: SNAP,
    contextPacketObjectDigest: ZERO,
    compiledConversationObjectDigest: ZERO,
    conversationBytes: Buffer.from("export function parse(): number { return 0; }", "utf8"),
    sourceRefs: [REF],
    provider: provider(),
    policy: {
      projectClassification: "internal",
      permittedEgressClassifications: ["public", "internal", "confidential"],
      explicitApproval: true,
      contractualRetention: true,
      noEgressCloudRoleAvailable: false,
    },
    expiresAt: "2026-08-28T01:00:00.000Z",
  });
  expect(outcome.kind).toBe("manifest");
  if (outcome.kind !== "manifest") {
    return;
  }
  expect(outcome.manifest.classification).not.toBe("restricted");
  expect(outcome.manifest.scannerVersions.length).toBeGreaterThan(0);
  expect(outcome.manifest.providerChain).toEqual(["example-cloud"]);
});
