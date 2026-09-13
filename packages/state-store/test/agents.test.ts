import { expect, test } from "vitest";
import { bootstrapTrustedWorld, createTaskRun, openTempStore, runIdFor } from "./helpers.js";

test("multi-agent tables persist nodes handles leases and tokens", () => {
  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-agents");
    const runId = runIdFor("00a1");
    createTaskRun(opened.store, world, runId);
    const node = opened.store.upsertAgentNode(world.projectScope, {
      runId,
      nodeId: "analyst",
      attempt: 1,
      status: "SPAWNED",
      role: "analyst",
      idempotencyKey: `${runId}:analyst:1`,
      updatedAt: "2026-09-13T00:00:00.000Z",
      agentId: "agent_01234567-89ab-7cde-8f01-23456789abcd",
    });
    expect(node.status).toBe("SPAWNED");
    const handle = opened.store.putAgentHandle(world.projectScope, {
      agentId: "agent_01234567-89ab-7cde-8f01-23456789abcd",
      runId,
      nodeId: "analyst",
      role: "analyst",
      sessionId: "sess-1",
      adapter: "control-plane-session",
      adapterVersion: "1.0.0",
      toolProfile: "read",
      capabilityTokenId: "cap_01234567-89ab-7cde-8f01-23456789abcd",
      spawnedAt: "2026-09-13T00:00:00.000Z",
      lastHeartbeatAt: "2026-09-13T00:00:00.000Z",
    });
    expect(handle.sessionId).toBe("sess-1");
    const lease = opened.store.putWorkspaceLease(world.projectScope, {
      leaseId: "lease_01234567-89ab-7cde-8f01-23456789abcd",
      runId,
      nodeId: "implementer",
      overlayPath: "C:/tmp/overlay",
      branch: "hec/run",
      baseCommit: "abc",
      isolationVerified: true,
      createdAt: "2026-09-13T00:00:00.000Z",
      expiresAt: "2026-09-13T01:00:00.000Z",
    });
    expect(lease.isolationVerified).toBe(true);
    const token = opened.store.putCapabilityToken(world.projectScope, {
      tokenId: "cap_01234567-89ab-7cde-8f01-23456789abcd",
      runId,
      nodeId: "analyst",
      agentId: "agent_01234567-89ab-7cde-8f01-23456789abcd",
      role: "analyst",
      mac: "aa".repeat(32),
      issuedAt: "2026-09-13T00:00:00.000Z",
      expiresAt: "2026-09-13T01:00:00.000Z",
    });
    expect(token.role).toBe("analyst");
    opened.store.appendAgentNodeEvent(world.projectScope, {
      eventId: "evt_1",
      runId,
      nodeId: "analyst",
      sequence: 1,
      eventType: "NODE_SPAWNED",
      payloadDigest: "sha256:" + "ab".repeat(32),
      occurredAt: "2026-09-13T00:00:00.000Z",
      agentId: "agent_01234567-89ab-7cde-8f01-23456789abcd",
    });
    expect(opened.store.listAgentNodes(world.projectScope, runId)).toHaveLength(1);
    expect(opened.store.listAgentHandles(world.projectScope, runId)).toHaveLength(1);
    expect(opened.store.listAgentNodeEvents(world.projectScope, runId)).toHaveLength(1);
    expect(opened.store.listWorkspaceLeases(world.projectScope, runId)).toHaveLength(1);
    expect(opened.store.deleteWorkspaceLease(world.projectScope, lease.leaseId)).toBe(true);
    expect(opened.store.listWorkspaceLeases(world.projectScope, runId)).toHaveLength(0);
    const expired = opened.store.putWorkspaceLease(world.projectScope, {
      leaseId: "lease_01234567-89ab-7cde-8f01-23456789abce",
      runId,
      nodeId: "implementer",
      overlayPath: "C:/tmp/overlay-expired",
      branch: "hec/run_expired/implementer",
      baseCommit: "abc",
      isolationVerified: true,
      createdAt: "2026-09-13T00:00:00.000Z",
      expiresAt: "2026-09-13T00:30:00.000Z",
    });
    expect(expired.leaseId).toContain("lease_");
    expect(opened.store.listExpiredWorkspaceLeases("2026-09-13T01:00:00.000Z")).toHaveLength(1);
    expect(opened.store.deleteWorkspaceLease(world.projectScope, "missing-lease")).toBe(false);
    opened.store.upsertAgentNode(world.projectScope, {
      runId,
      nodeId: "implementer",
      attempt: 2,
      status: "RETRYING",
      role: "implementer",
      idempotencyKey: `${runId}:implementer:2`,
      updatedAt: "2026-09-13T00:00:00.000Z",
    });
    expect(opened.store.listRetryingAgentRuns()).toEqual([{ projectId: world.projectId, runId }]);
    expect(
      opened.store.getCapabilityToken(
        world.projectScope,
        "cap_01234567-89ab-7cde-8f01-23456789abcd",
      ).mac,
    ).toBe("aa".repeat(32));
  } finally {
    opened.close();
  }
});
