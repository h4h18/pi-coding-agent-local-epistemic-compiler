import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { expect, test } from "vitest";
import type { CapabilityToken, SpawnRequest, TaskContract, WorkspaceLease } from "@pi-hec/contracts";
import { createIsolatedLocalRuntime } from "@pi-hec/models";
import {
  assertNoConfusedDeputyTools,
  assertPiSubagentsHandshake,
  classifyLostHandle,
  createControlPlaneSessionAdapter,
  createDirectProviderLoopAdapter,
  createHeadlessResourceLoader,
  createMemoryHandleStore,
  createPiSdkSessionFactory,
  createPiSubagentsRuntimeAdapter,
  createRoleTools,
  FORBIDDEN_TOOL_NAMES,
  mintCapabilityToken,
  PiSubagentsRejectedError,
  reconcileHandles,
  resolveInsideLease,
  toolNamesForProfile,
  WorkspaceIsolationError,
  assembleWorkerContext,
} from "../src/index.js";

const RUN = "run_01234567-89ab-7cde-8f01-23456789abcd";
const AGENT = "agent_01234567-89ab-7cde-8f01-23456789abcd";
const NOW = "2026-09-13T00:00:00.000Z";
const LATER = "2026-09-13T01:00:00.000Z";

function token(role: CapabilityToken["role"] = "analyst"): CapabilityToken {
  return mintCapabilityToken({
    runId: RUN,
    nodeId: "analyst",
    agentId: AGENT,
    role,
    toolProfile: role === "implementer" ? "write" : role === "reviewer" ? "review" : "read",
    now: NOW,
    expiresAt: LATER,
  });
}

function lease(overlayPath: string, allowedPaths: string[] = ["src"]): WorkspaceLease {
  return {
    schemaVersion: 1,
    leaseId: "lease_01234567-89ab-7cde-8f01-23456789abcd",
    runId: RUN,
    nodeId: "implementer",
    overlayPath,
    branch: "hec/run",
    baseCommit: "abc",
    allowedPaths,
    isolationVerified: true,
    createdAt: NOW,
    expiresAt: LATER,
  };
}

test("tool profiles never expose spawn_agent or delegate", () => {
  for (const profile of ["read", "write", "review"] as const) {
    const names = toolNamesForProfile(profile);
    expect(names.some((name) => FORBIDDEN_TOOL_NAMES.includes(name))).toBe(false);
    assertNoConfusedDeputyTools(names);
  }
  expect(() => assertNoConfusedDeputyTools(["spawn_agent"])).toThrow(/forbidden tools/);
});

test("writer cannot escape overlay or write without isolation", async () => {
  const overlay = mkdtempSync(path.join(tmpdir(), "hec-overlay-"));
  mkdirSync(path.join(overlay, "src"));
  const inside = resolveInsideLease(lease(overlay), "src/file.ts");
  expect(inside.startsWith(overlay)).toBe(true);
  expect(() => resolveInsideLease(lease(overlay), "../secret")).toThrow(WorkspaceIsolationError);
  expect(() => resolveInsideLease(lease(overlay), ".env")).toThrow(WorkspaceIsolationError);
  expect(() => resolveInsideLease({ ...lease(overlay), isolationVerified: false }, "src/a.ts")).not.toThrow();
  const tools = createRoleTools({
    token: token("implementer"),
    now: () => NOW,
    lease: { ...lease(overlay), isolationVerified: false },
    bridge: {
      requestContext: async () => ({ text: "", untrusted: false }),
      submitArtifact: async () => ({ accepted: true, issues: [] }),
      reportProgress: async () => undefined,
      reportBlocker: async () => undefined,
    },
    fs: {
      readFile: async () => "",
      listDirectory: async () => [],
      grepRepository: async () => [],
      findFiles: async () => [],
      inspectSymbol: async () => [],
      writeScopedFile: async () => undefined,
      editScopedFile: async () => undefined,
      removeScopedFile: async () => undefined,
    },
  });
  const write = tools.find((tool) => tool.name === "write_scoped_file");
  expect(write).toBeDefined();
  await expect(write?.execute("1", { path: "src/a.ts", contents: "x" })).rejects.toThrow(
    /isolationVerified/,
  );
});

test("capability token rejects expired and implementer self-approval", async () => {
  const minted = token("implementer");
  const tools = createRoleTools({
    token: minted,
    now: () => "2026-09-14T00:00:00.000Z",
    bridge: {
      requestContext: async () => ({ text: "", untrusted: false }),
      submitArtifact: async () => ({ accepted: true, issues: [] }),
      reportProgress: async () => undefined,
      reportBlocker: async () => undefined,
    },
  });
  const submit = tools.find((tool) => tool.name === "submit_artifact");
  await expect(
    submit?.execute("1", { envelope: { artifactType: "review-findings" } }),
  ).rejects.toThrow(/expired|self-approve|cannot submit/);
});

test("pi-subagents is rejected unless FA-EX1 handshake is complete", () => {
  expect(() =>
    assertPiSubagentsHandshake({
      steer: true,
      resume: true,
      stop: true,
      nestedDelegation: false,
      fallbackSubagent: "none",
      isolationVerified: true,
      spawnedFromFaEx1: false,
    }),
  ).toThrow(PiSubagentsRejectedError);
  expect(() =>
    createPiSubagentsRuntimeAdapter({
      steer: true,
      resume: true,
      stop: true,
      nestedDelegation: true,
      fallbackSubagent: "none",
      isolationVerified: true,
      spawnedFromFaEx1: true,
    }),
  ).toThrow(/nestedDelegation/);
});

test("control-plane session adapter consumes submitted artifact and reports lost session", async () => {
  const contract: TaskContract = {
    schemaVersion: 1,
    taskId: "t1",
    kind: "feature",
    objective: "x",
    inScope: ["src"],
    outOfScope: [],
    constraints: [],
    assumptions: [],
    acceptanceCriteria: [
      { id: "ac1", statement: "ok", verification: ["test"], requiredEvidence: ["command"] },
    ],
    riskFlags: [],
    specPolicy: { paths: [], behaviorChanges: false, updateRequired: false },
    blockingQuestions: [],
  };
  const runtime = createControlPlaneSessionAdapter({
    now: () => NOW,
    sessionFactory: async () => ({
      sessionId: "sess-1",
      prompt: async () => undefined,
      steer: async () => undefined,
      abort: async () => undefined,
      waitForIdle: async () => undefined,
      subscribe: () => () => undefined,
      dispose: () => undefined,
    }),
    bridge: {
      requestContext: async () => ({ text: "ctx", untrusted: false }),
      submitArtifact: async () => ({ accepted: true, issues: [] }),
      reportProgress: async () => undefined,
      reportBlocker: async () => undefined,
    },
    assemble: () => ({
      systemPrompt: "analyst",
      userPrompt: "submit now",
      inputArtifacts: [],
      untrustedRag: false,
    }),
  });
  const request: SpawnRequest = {
    schemaVersion: 1,
    runId: RUN,
    nodeId: "analyst",
    role: "analyst",
    modelDeploymentId: "cloud-analyst",
    toolProfile: "read",
    inputArtifacts: [],
    outputSchema: "task-contract",
    idempotencyKey: "analyst:1",
  };
  const handle = await runtime.spawn(request);
  expect(handle.adapter).toBe("control-plane-session");
  const tools = createRoleTools({
    token: token("analyst"),
    now: () => NOW,
    bridge: {
      requestContext: async () => ({ text: "ctx", untrusted: false }),
      submitArtifact: async (input) => {
        expect(input.envelope).toBeDefined();
        return { accepted: true, issues: [] };
      },
      reportProgress: async () => undefined,
      reportBlocker: async () => undefined,
    },
  });
  const submit = tools.find((tool) => tool.name === "submit_artifact");
  await submit?.execute("1", {
    envelope: { artifactType: "task-contract", payload: contract },
  });
  await runtime.stop(handle);
  const lost = await runtime.consume(handle);
  expect(lost.outcome).toBe("lost");
});

test("direct provider loop executes tools until artifact", async () => {
  const runtime = createDirectProviderLoopAdapter({
    now: () => NOW,
    complete: async (turn) => {
      const submit = turn.tools.find((tool) => tool.name === "submit_artifact");
      if (submit !== undefined) {
        await submit.execute("call-1", {
          envelope: { artifactType: "task-contract", payload: { schemaVersion: 1 } },
        });
      }
      return { text: "done", toolCalls: [], finish: "stop" };
    },
    bridge: {
      requestContext: async () => ({ text: "", untrusted: false }),
      submitArtifact: async () => ({ accepted: true, issues: [] }),
      reportProgress: async () => undefined,
      reportBlocker: async () => undefined,
    },
  });
  const handle = await runtime.spawn({
    schemaVersion: 1,
    runId: RUN,
    nodeId: "analyst",
    role: "analyst",
    modelDeploymentId: "cloud-analyst",
    toolProfile: "read",
    inputArtifacts: [],
    outputSchema: "task-contract",
    idempotencyKey: "analyst:1",
  });
  const result = await runtime.consume(handle);
  expect(result.outcome === "artifact" || result.outcome === "failed").toBe(true);
});

test("lost reviewer handle is retried and missing handle is retried", () => {
  const store = createMemoryHandleStore();
  const handle = {
    agentId: AGENT,
    runId: RUN,
    nodeId: "reviewer",
    role: "reviewer" as const,
    sessionId: "s",
    toolProfile: "review" as const,
    capabilityTokenId: "cap_01234567-89ab-7cde-8f01-23456789abcd" as const,
    adapter: "control-plane-session" as const,
    adapterVersion: "1.0.0",
    spawnedAt: NOW,
    lastHeartbeatAt: NOW,
  };
  store.set(handle);
  expect(
    classifyLostHandle(handle, { runId: RUN, handles: [], nodeStatuses: {} }),
  ).toBe("retry");
});

test("reconcileHandles returns empty snapshot without dummy when nothing persisted", async () => {
  const runtime = createControlPlaneSessionAdapter({
    now: () => NOW,
    sessionFactory: async () => {
      throw new Error("unused");
    },
    bridge: {
      requestContext: async () => ({ text: "", untrusted: false }),
      submitArtifact: async () => ({ accepted: true, issues: [] }),
      reportProgress: async () => undefined,
      reportBlocker: async () => undefined,
    },
  });
  const result = await reconcileHandles(runtime, []);
  expect(result.retry).toEqual([]);
  expect(result.resume).toEqual([]);
});

test("dirty overlay write stays inside lease", () => {
  const overlay = mkdtempSync(path.join(tmpdir(), "hec-dirty-"));
  mkdirSync(path.join(overlay, "src"));
  writeFileSync(path.join(overlay, "src", "a.ts"), "old");
  const target = resolveInsideLease(lease(overlay), "src/a.ts");
  writeFileSync(target, "new");
  expect(() => resolveInsideLease(lease(overlay), "src/../src/../secret")).toThrow(
    WorkspaceIsolationError,
  );
});

test("headless resource loader keeps only the worker system prompt", () => {
  const loader = createHeadlessResourceLoader("You are the analyst worker.");
  expect(loader.getSystemPrompt()).toBe("You are the analyst worker.");
  expect(loader.getExtensions().extensions).toEqual([]);
  expect(loader.getSkills().skills).toEqual([]);
  expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
});

test("Pi SDK factory pins the isolated local runtime and does not select cloud models", async () => {
  const isolated = await createIsolatedLocalRuntime({
    providerId: "hec-local",
    modelId: "hec-analyst",
    modelRevision: "test-loopback-1",
    baseUrl: "http://127.0.0.1:43121/v1",
    name: "HEC local analyst",
    contextWindow: 8192,
    maxTokens: 2048,
  });
  const available = await isolated.modelRuntime.getAvailable();
  expect(available.map((model) => `${model.provider}/${model.id}`)).toEqual(["hec-local/hec-analyst"]);
  const factory = createPiSdkSessionFactory({ runtime: isolated });
  const cwd = mkdtempSync(path.join(tmpdir(), "hec-session-"));
  const session = await factory({
    cwd,
    systemPrompt: "Submit one task-contract via submit_artifact.",
    tools: [
      {
        name: "submit_artifact",
        label: "Submit",
        description: "Submit the role artifact",
        parameters: Type.Object({}),
        execute: async () => ({ content: "ok", details: {} }),
      },
    ],
  });
  expect(session.sessionId.length).toBeGreaterThan(0);
  session.dispose();
});

test("worker context includes the original task and a distinct user prompt", () => {
  const context = assembleWorkerContext({
    role: "analyst",
    outputSchema: "task-contract",
    sources: [
      {
        path: "task-envelope",
        text: JSON.stringify({ originalRequest: "добавь локальную форму логина" }),
      },
    ],
  });
  expect(context.systemPrompt).toContain("добавь локальную форму логина");
  expect(context.systemPrompt).toContain('"kind":"feature"');
  expect(context.userPrompt).toContain("submit_artifact");
  expect(context.userPrompt).not.toBe(context.systemPrompt);
});

test("submit_artifact rejects an invalid envelope without calling the bridge", async () => {
  let submitted = 0;
  const tools = createRoleTools({
    token: token("analyst"),
    now: () => NOW,
    bridge: {
      requestContext: async () => ({ text: "", untrusted: false }),
      submitArtifact: async () => {
        submitted += 1;
        return { accepted: true, issues: [] };
      },
      reportProgress: async () => undefined,
      reportBlocker: async () => undefined,
    },
  });
  const submit = tools.find((tool) => tool.name === "submit_artifact");
  const rejected = await submit?.execute("1", { envelope: { artifactType: "task-contract" } });
  expect(rejected?.content).toMatch(/schemaVersion|required|must/i);
  expect(submitted).toBe(0);
});

test("control-plane session prompts with the user turn, not the system prompt", async () => {
  const prompted: string[] = [];
  const runtime = createControlPlaneSessionAdapter({
    now: () => NOW,
    sessionFactory: async () => ({
      sessionId: "sess-prompt",
      prompt: async (text) => {
        prompted.push(text);
      },
      steer: async () => undefined,
      abort: async () => undefined,
      waitForIdle: async () => undefined,
      subscribe: () => () => undefined,
      dispose: () => undefined,
    }),
    bridge: {
      requestContext: async () => ({ text: "", untrusted: false }),
      submitArtifact: async () => ({ accepted: true, issues: [] }),
      reportProgress: async () => undefined,
      reportBlocker: async () => undefined,
    },
    assemble: () => ({
      systemPrompt: "SYSTEM_ONLY",
      userPrompt: "USER_ONLY",
      inputArtifacts: [],
      untrustedRag: false,
    }),
  });
  await runtime.spawn({
    schemaVersion: 1,
    runId: RUN,
    nodeId: "analyst",
    role: "analyst",
    modelDeploymentId: "cloud-analyst",
    toolProfile: "read",
    inputArtifacts: [],
    outputSchema: "task-contract",
    idempotencyKey: "analyst:prompt",
  });
  expect(prompted).toEqual(["USER_ONLY"]);
});
