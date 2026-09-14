import { expect, test } from "vitest";
import type { ChangeManifest, ChangeShard, TaskContract } from "@pi-hec/contracts";
import {
  activeWriterCount,
  checkIntegration,
  compileAcceptanceLedger,
  dagComplete,
  dagUnrecoverable,
  definitionOfDoneSatisfied,
  detectConflictMarkers,
  failureFingerprint,
  initialNodeRecords,
  mandatorySkillIdsFor,
  mergeTightening,
  projectContractToLedger,
  readyNodes,
  reduceNode,
  roleMayProduce,
  selectWorkflowProfile,
  shouldChangeStrategy,
  skippedDisabledNodes,
  validateWorkerEnvelope,
  workflowProfileById,
} from "../src/index.js";

const RUN = "run_01234567-89ab-7cde-8f01-23456789abcd";
const AGENT = "agent_01234567-89ab-7cde-8f01-23456789abcd";

function contract(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    schemaVersion: 1,
    taskId: "task-1",
    kind: "feature",
    objective: "add login",
    inScope: ["src/auth"],
    outOfScope: ["docs"],
    constraints: [],
    assumptions: [{ id: "a1", text: "local", reversible: true, evidence: [] }],
    acceptanceCriteria: [
      {
        id: "ac1",
        statement: "login works",
        verification: ["test"],
        requiredEvidence: ["command", "diff", "review"],
      },
    ],
    riskFlags: [],
    specPolicy: { paths: ["specs"], behaviorChanges: false, updateRequired: false },
    blockingQuestions: [],
    ...overrides,
  };
}

test("router compiles FAST for local reversible feature and auth-bugfix as bugfix+security overlay", () => {
  const fast = selectWorkflowProfile({
    kind: "feature",
    riskFlags: [],
    behaviorChange: false,
    localScope: true,
    reversible: true,
    noTests: false,
    unstableBug: false,
    multiSubsystem: false,
    externalResearch: false,
  });
  expect(fast.composition.executionBudget).toBe("fast");
  expect(fast.composition.primaryIntent).toBe("feature");
  expect(fast.compiled.nodes.filter((node) => node.role === "investigator")).toHaveLength(1);
  expect(fast.compiled.nodes.some((node) => node.id === "plan-critic")).toBe(false);
  const authBug = selectWorkflowProfile({
    kind: "bugfix",
    riskFlags: ["auth"],
    behaviorChange: true,
    localScope: false,
    reversible: false,
    noTests: false,
    unstableBug: false,
    multiSubsystem: false,
    externalResearch: false,
  });
  expect(authBug.composition.primaryIntent).toBe("bugfix");
  expect(authBug.composition.overlays).toContain("security-sensitive");
  expect(authBug.compiled.nodes.some((node) => node.id === "security-reviewer")).toBe(true);
  expect(authBug.compiled.nodes.some((node) => node.id === "reproduction-investigator")).toBe(true);
  expect(authBug.profileId).not.toBe("HIGH_RISK");
  expect(
    selectWorkflowProfile({
      kind: "research",
      riskFlags: [],
      behaviorChange: false,
      localScope: true,
      reversible: true,
      noTests: false,
      unstableBug: false,
      multiSubsystem: false,
      externalResearch: false,
    }).composition.deliveryMode,
  ).toBe("analysis-only");
  expect(
    selectWorkflowProfile({
      kind: "spec",
      riskFlags: [],
      behaviorChange: true,
      localScope: true,
      reversible: true,
      noTests: false,
      unstableBug: false,
      multiSubsystem: false,
      externalResearch: false,
    }).profileId,
  ).toBe("SPEC_ONLY");
  expect(
    selectWorkflowProfile({
      kind: "refactor",
      riskFlags: [],
      behaviorChange: false,
      localScope: true,
      reversible: true,
      noTests: false,
      unstableBug: false,
      multiSubsystem: false,
      externalResearch: false,
    }).composition.primaryIntent,
  ).toBe("refactor");
});

test("DAG keeps a single writer and skips disabled HIGH_RISK nodes", () => {
  const profile = workflowProfileById("FEATURE");
  const nodes = initialNodeRecords(profile).map((node) =>
    node.nodeId === "analyst" ||
    node.nodeId === "code-investigator" ||
    node.nodeId === "spec-investigator" ||
    node.nodeId === "planner"
      ? { ...node, status: "ACCEPTED" as const }
      : node,
  );
  const cursor = { profile, nodes, predicates: [] };
  expect(skippedDisabledNodes(cursor)).toContain("plan-critic");
  const ready = readyNodes(cursor).map((node) => node.id);
  expect(ready).toContain("implementer");
  expect(activeWriterCount({
    ...cursor,
    nodes: nodes.map((node) =>
      node.nodeId === "implementer" ? { ...node, status: "SPAWNED" as const } : node,
    ),
  })).toBe(1);
});

test("BUGFIX DAG is unrecoverable after planner fails and nothing else is ready", () => {
  const profile = workflowProfileById("BUGFIX");
  const nodes = initialNodeRecords(profile).map((node) => {
    if (
      node.nodeId === "analyst" ||
      node.nodeId === "reproduction-investigator" ||
      node.nodeId === "root-cause-investigator"
    ) {
      return { ...node, status: "ACCEPTED" as const };
    }
    if (node.nodeId === "planner") {
      return { ...node, status: "FAILED" as const, attempt: 3 };
    }
    return node;
  });
  const cursor = { profile, nodes, predicates: [] };
  expect(dagComplete(cursor)).toBe(false);
  expect(readyNodes(cursor)).toEqual([]);
  expect(dagUnrecoverable(cursor)).toBe(true);
  expect(
    dagUnrecoverable({
      ...cursor,
      nodes: nodes.map((node) =>
        node.nodeId === "planner" ? { ...node, status: "RETRYING" as const, attempt: 2 } : node,
      ),
    }),
  ).toBe(false);
});

test("retrying implementer is ready again and does not occupy the writer slot", () => {
  const profile = workflowProfileById("FEATURE");
  const nodes = initialNodeRecords(profile).map((node) => {
    if (
      node.nodeId === "analyst" ||
      node.nodeId === "code-investigator" ||
      node.nodeId === "spec-investigator" ||
      node.nodeId === "planner"
    ) {
      return { ...node, status: "ACCEPTED" as const };
    }
    if (node.nodeId === "implementer") {
      return { ...node, status: "RETRYING" as const, attempt: 2 };
    }
    return node;
  });
  const cursor = { profile, nodes, predicates: [] };
  expect(activeWriterCount(cursor)).toBe(0);
  expect(readyNodes(cursor).map((node) => node.id)).toContain("implementer");
});

test("spawned writer still serializes a second write node", () => {
  const profile = workflowProfileById("FEATURE");
  const nodes = initialNodeRecords(profile).map((node) => {
    if (
      node.nodeId === "analyst" ||
      node.nodeId === "code-investigator" ||
      node.nodeId === "spec-investigator" ||
      node.nodeId === "planner" ||
      node.nodeId === "implementer" ||
      node.nodeId === "integration" ||
      node.nodeId === "verification" ||
      node.nodeId === "reviewer"
    ) {
      return {
        ...node,
        status: node.nodeId === "implementer" ? ("SPAWNED" as const) : ("ACCEPTED" as const),
      };
    }
    return node;
  });
  const cursor = { profile, nodes, predicates: ["HAS_BLOCKING_FINDINGS"] };
  expect(activeWriterCount(cursor)).toBe(1);
  expect(readyNodes(cursor).map((node) => node.id)).not.toContain("repair-implementer");
});

test("node reducer rejects illegal transitions and retries from FAILED", () => {
  const spawned = reduceNode({ nodeId: "analyst", status: "PENDING", attempt: 0 }, "NODE_SPAWNED");
  expect(spawned.status).toBe("SPAWNED");
  expect(() => reduceNode(spawned, "NODE_COMPLETED")).toThrow(/illegal node transition/);
  const failed = reduceNode(spawned, "NODE_FAILED");
  expect(failed.status).toBe("FAILED");
  const retried = reduceNode(failed, "NODE_SPAWNED");
  expect(retried.status).toBe("SPAWNED");
  const waiting = reduceNode(spawned, "NODE_RETRYING");
  expect(waiting.status).toBe("RETRYING");
});

test("hard skill rules bind debugging and spec write", () => {
  expect(mandatorySkillIdsFor({ kind: "bugfix", riskFlags: [], behaviorChange: false })).toEqual([
    "debugging",
    "project-testing",
  ]);
  expect(
    mandatorySkillIdsFor({ kind: "feature", riskFlags: ["public-api"], behaviorChange: true }),
  ).toEqual(["api-compatibility", "spec-read", "spec-write"]);
});

test("role artifact matrix and envelope validation reject implementer self-approval", () => {
  expect(roleMayProduce("analyst", "task-contract")).toBe(true);
  expect(roleMayProduce("implementer", "review-findings")).toBe(false);
  const result = validateWorkerEnvelope(
    {
      schemaVersion: 1,
      artifactType: "task-contract",
      runId: RUN,
      nodeId: "analyst",
      agentId: AGENT,
      inputs: [],
      payload: contract({ inScope: ["docs"], outOfScope: ["docs"] }),
    },
    { runId: RUN, nodeId: "analyst", agentId: AGENT, artifactType: "task-contract" },
  );
  expect(result.ok).toBe(false);
});

test("acceptance ledger closes only with command diff review and DoD", () => {
  const ledger = compileAcceptanceLedger({
    contract: contract(),
    contractRevision: 1,
    integrationCommit: "abc",
    commandEvidence: [
      {
        schemaVersion: 1,
        evidenceId: "cmd-1",
        producedBy: "controller",
        runId: RUN,
        nodeId: "verification",
        commitSha: "abc",
        workspaceLeaseId: "lease_01234567-89ab-7cde-8f01-23456789abcd",
        executable: "pnpm",
        args: ["test"],
        cwd: "/overlay",
        environmentDigest: "sha256:" + "ab".repeat(32),
        startedAt: "2026-09-13T00:00:00.000Z",
        durationMs: 10,
        exitCode: 0,
        stdoutDigest: "sha256:" + "ab".repeat(32),
        stderrDigest: "sha256:" + "cd".repeat(32),
        artifactPaths: [],
      },
    ],
    reviewFindings: [
      {
        schemaVersion: 1,
        runId: RUN,
        nodeId: "reviewer",
        agentId: AGENT,
        findings: [],
        blocking: false,
        summary: "ok",
      },
    ],
    diffPaths: ["src/auth/login.ts"],
    specUpdateSatisfied: true,
    blockingFindings: false,
    preExistingFailures: [],
  });
  expect(ledger.closed).toBe(true);
  expect(
    definitionOfDoneSatisfied({
      contractValid: true,
      ledger,
      integrationCommit: "abc",
      baselineCommit: "base",
      outOfScopeChanges: false,
      gatesPassed: true,
      blockingFindings: false,
      freshReviewAfterRepair: true,
      specSatisfied: true,
      userTreeUntouched: true,
    }),
  ).toBe(true);
});

test("requirement projection and integration reject conflict markers", () => {
  const ledger = projectContractToLedger({
    runId: RUN,
    originalRequest: "add login",
    contract: contract(),
    sourceRefs: [],
  });
  expect(ledger.requirements).toHaveLength(1);
  expect(ledger.requirements[0]?.id.startsWith("req_")).toBe(true);
  const manifest = {
    schemaVersion: 1,
    runId: RUN,
    nodeId: "implementer",
    agentId: AGENT,
    leaseId: "lease_01234567-89ab-7cde-8f01-23456789abcd",
    baseCommit: "base",
    changedPaths: ["src/auth/login.ts"],
    specPaths: [],
    allowedPaths: ["src/auth"],
  } satisfies ChangeManifest;
  expect(
    checkIntegration({
      manifest,
      fileContents: { "src/auth/login.ts": "<<<<<<< HEAD\n" },
    }).ok,
  ).toBe(false);
  expect(detectConflictMarkers({ "src/auth/login.ts": "ok" })).toEqual([]);
  const shards: ChangeShard[] = [
    {
      id: "s1",
      files: ["a.ts"],
      symbols: [],
      contractsConsumed: [],
      contractsModified: [],
      sharedResources: [],
      generatedOutputs: [],
      dependsOn: [],
    },
    {
      id: "s2",
      files: ["b.ts"],
      symbols: [],
      contractsConsumed: [],
      contractsModified: [],
      sharedResources: [],
      generatedOutputs: [],
      dependsOn: ["s1"],
    },
  ];
  expect(checkIntegration({ manifest, fileContents: { "src/auth/login.ts": "ok" }, shards }).ok).toBe(
    true,
  );
});

test("repair fingerprint forces strategy change after two identical failures", () => {
  const digest = failureFingerprint({ nodeId: "implementer", findingIds: ["f1"], exitCodes: [1] });
  expect(
    shouldChangeStrategy(
      [
        { digest, cycle: 1 },
        { digest, cycle: 2 },
      ],
      digest,
    ),
  ).toBe(true);
});

test("project adapter cannot weaken network deny", () => {
  const locked = mergeTightening(
    {
      schemaVersion: 1,
      project: { id: "p", adapter: "a" },
      spec: { roots: ["specs"], behaviorChangeRequiresUpdate: false },
      verification: { baseline: [], targeted: [], final: [] },
      protectedPaths: [".env"],
      network: { default: "deny", externalResearch: "allow" },
    },
    {
      schemaVersion: 1,
      project: { id: "p", adapter: "a" },
      spec: { roots: ["docs"], behaviorChangeRequiresUpdate: true },
      verification: { baseline: [], targeted: [], final: [] },
      protectedPaths: [".git"],
      network: { default: "deny", externalResearch: "deny" },
    },
  );
  expect(locked.network.default).toBe("deny");
  expect(locked.network.externalResearch).toBe("deny");
  expect(locked.spec.behaviorChangeRequiresUpdate).toBe(true);
});
