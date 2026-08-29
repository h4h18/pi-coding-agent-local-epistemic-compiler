import { expect, test } from "vitest";
import { StoreLookupError, UntrustedProjectError } from "../src/index.js";
import {
  artifact,
  bootstrapTrustedWorld,
  digestOf,
  LATER,
  NOW,
  openTempStore,
  principalScope,
  runIdFor,
  seedHostAuthority,
} from "./helpers.js";

test("two projects with reused ids do not leak runs, usage, approvals, or occupancy", () => {
  const opened = openTempStore();
  try {
    const a = bootstrapTrustedWorld(opened.store, "proj-a");
    const b = bootstrapTrustedWorld(opened.store, "proj-b");
    const sharedRun = runIdFor("0400");
    const sharedDigest = digestOf("shared-task");
    opened.store.putArtifact(a.projectScope, artifact(sharedDigest, "TaskEnvelope", "task-a"));
    opened.store.putArtifact(b.projectScope, artifact(sharedDigest, "TaskEnvelope", "task-b"));
    opened.store.createRun(a.projectScope, {
      runId: sharedRun,
      workspaceId: a.workspaceId,
      taskEnvelopeDigest: sharedDigest,
      createdAt: NOW,
    });
    opened.store.createRun(b.projectScope, {
      runId: sharedRun,
      workspaceId: b.workspaceId,
      taskEnvelopeDigest: sharedDigest,
      createdAt: NOW,
    });
    expect(opened.store.getRun(a.projectScope, sharedRun).workspaceId).toBe(a.workspaceId);
    expect(opened.store.getRun(b.projectScope, sharedRun).workspaceId).toBe(b.workspaceId);
    expect(opened.store.isGcForbidden(a.projectScope, sharedDigest)).toBe(true);
    expect(opened.store.isGcForbidden(b.projectScope, sharedDigest)).toBe(true);
    const requestDigest = digestOf("shared-cloud-request");
    const contextDigest = digestOf("shared-cloud-context");
    opened.store.putArtifact(a.projectScope, artifact(requestDigest, "CanonicalCloudRequest", "req-a"));
    opened.store.putArtifact(a.projectScope, artifact(contextDigest, "ContextPacket", "ctx-a"));
    opened.store.putArtifact(b.projectScope, artifact(requestDigest, "CanonicalCloudRequest", "req-b"));
    opened.store.putArtifact(b.projectScope, artifact(contextDigest, "ContextPacket", "ctx-b"));
    opened.store.createCloudCall(a.projectScope, {
      cloudCallId: "call-shared",
      runId: sharedRun,
      purpose: "initial",
      deploymentId: "dep-a",
      requestDigest,
      contextPacketDigest: contextDigest,
      recoveryGrade: "A",
      state: "prepared",
      createdAt: NOW,
    });
    opened.store.createCloudCall(b.projectScope, {
      cloudCallId: "call-shared",
      runId: sharedRun,
      purpose: "initial",
      deploymentId: "dep-b",
      requestDigest,
      contextPacketDigest: contextDigest,
      recoveryGrade: "A",
      state: "prepared",
      createdAt: NOW,
    });
    opened.store.appendUsage(a.projectScope, {
      usageEntryId: "usage-shared",
      cloudCallId: "call-shared",
      createdAt: NOW,
      inputTokens: 3,
      outputTokens: 1,
      reasoningTokens: 0,
      normalizedTotalTokens: 4,
      providerReported: true,
      complete: true,
    });
    opened.store.appendUsage(b.projectScope, {
      usageEntryId: "usage-shared",
      cloudCallId: "call-shared",
      createdAt: LATER,
      inputTokens: 9,
      outputTokens: 2,
      reasoningTokens: 0,
      normalizedTotalTokens: 11,
      providerReported: true,
      complete: true,
    });
    expect(opened.store.getUsage(a.projectScope, "usage-shared").createdAt).toBe(NOW);
    expect(opened.store.getUsage(b.projectScope, "usage-shared").createdAt).toBe(LATER);
    expect(() => opened.store.getUsage(a.projectScope, "usage-missing")).toThrow(StoreLookupError);
    const outsider = principalScope(["proj-a"]);
    const outsiderProject = opened.store.toProjectScope(outsider, "proj-a");
    expect(() => opened.store.toProjectScope(outsider, "proj-b")).toThrow(StoreLookupError);
    expect(() => opened.store.getRun(outsiderProject, "missing")).toThrow(StoreLookupError);
    expect(opened.store.getApproval(a.projectScope, `trust-${a.projectId}`).action).toBe("project-trust");
    expect(() => opened.store.getApproval(a.projectScope, `trust-${b.projectId}`)).toThrow(StoreLookupError);
    expect(() => opened.store.getApproval(b.projectScope, `trust-${a.projectId}`)).toThrow(StoreLookupError);
  } finally {
    opened.close();
  }
});

test("untrusted project is created in one deferred FK transaction and blocks workspace/run writes", () => {
  const opened = openTempStore();
  try {
    const projectId = "proj-untrusted";
    const scope = principalScope([projectId]);
    seedHostAuthority(opened.store);
    opened.store.createUntrustedProject(scope, {
      projectId,
      displayName: "untrusted",
      classification: "internal",
      policy: artifact(digestOf("policy-untrusted"), "ProjectPolicy", "policy-untrusted"),
      createdAt: NOW,
    });
    const projectScope = opened.store.toProjectScope(scope, projectId);
    expect(opened.store.getProject(scope, projectId).trustState).toBe("untrusted");
    expect(() => {
      opened.store.createWorkspace(projectScope, {
        workspaceId: "ws-x",
        runnerId: "runner-shared",
        rootFingerprint: "fp",
        platform: "win32",
        brokerAttestationDigest: digestOf("broker-x"),
        registrationGrantDigest: digestOf("reg-x"),
        createdAt: NOW,
      });
    }).toThrow(UntrustedProjectError);
    expect(() =>
      opened.store.createRun(projectScope, {
        runId: runIdFor("0401"),
        workspaceId: "ws-x",
        taskEnvelopeDigest: digestOf("task-x"),
        createdAt: NOW,
      }),
    ).toThrow(UntrustedProjectError);
  } finally {
    opened.close();
  }
});

test("revoked runner-project grant cannot create a workspace", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-revoked-grant");
    opened.store.revokeRunnerProjectGrant(world.projectScope, {
      runnerId: world.runnerId,
      revokedAt: LATER,
    });
    const broker = digestOf("broker-revoked");
    const registration = digestOf("registration-revoked");
    opened.store.putArtifact(world.projectScope, artifact(broker, null, "broker-revoked"));
    opened.store.putArtifact(world.projectScope, artifact(registration, "ApprovalGrant", "reg-revoked"));
    expect(() => {
      opened.store.createWorkspace(world.projectScope, {
        workspaceId: "ws-after-revoke",
        runnerId: world.runnerId,
        rootFingerprint: "fp-revoked",
        platform: "win32",
        brokerAttestationDigest: broker,
        registrationGrantDigest: registration,
        createdAt: LATER,
      });
    }).toThrow(StoreLookupError);
  } finally {
    opened.close();
  }
});
