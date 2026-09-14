import { expect, test } from "vitest";
import { Compile } from "typebox/compile";
import {
  CompiledProfileSchema,
  type CommandSpec,
  type ProjectAdapter,
  type TaskContract,
} from "@pi-hec/contracts";
import {
  compileProfileFromContract,
  compileRunComposition,
  composeFromContract,
  composeFromSignals,
  resolvedVerificationPacks,
  selectWorkflowProfile,
} from "../src/index.js";

const COMPILED = Compile(CompiledProfileSchema);

function command(id: string): CommandSpec {
  return {
    schemaVersion: 1,
    id,
    authority: "VERIFIER_INTRINSIC",
    executable: "usr/bin/test-runner",
    argv: ["--ci"],
    workingDirectory: "repo",
    environment: {},
    secretHandles: [],
    network: "NONE",
    writableRoots: ["tmp"],
    timeoutPolicy: "SAFETY_BOUND",
    sourceRefs: [],
  };
}

function adapterWithPacks(): ProjectAdapter {
  return {
    schemaVersion: 1,
    project: { id: "demo", adapter: "demo" },
    spec: { roots: ["specs"], behaviorChangeRequiresUpdate: true },
    verification: {
      baseline: [],
      targeted: [],
      final: [],
      packs: {
        security: {
          obligationKinds: ["SECURITY"],
          commands: [command("secret-scan")],
          phase: "targeted",
        },
        "web-ui": {
          obligationKinds: ["ACCESSIBILITY", "BROWSER_INTERACTION"],
          commands: [command("a11y")],
          phase: "final",
        },
      },
    },
    protectedPaths: [".env"],
    network: { default: "deny", externalResearch: "deny" },
  };
}

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

test("auth bugfix compiles as bugfix plus security-sensitive, not HIGH_RISK feature DAG", () => {
  const result = compileProfileFromContract(
    contract({
      kind: "bugfix",
      riskFlags: ["auth"],
      specPolicy: { paths: ["specs"], behaviorChanges: true, updateRequired: false },
      inScope: ["src/auth/session.ts", "src/auth/login.ts", "src/auth/tokens.ts", "src/api"],
    }),
  );
  expect(COMPILED.Check(result.compiled)).toBe(true);
  expect(result.compiled.composition.primaryIntent).toBe("bugfix");
  expect(result.compiled.composition.overlays).toContain("security-sensitive");
  expect(result.compiled.nodes.some((node) => node.id === "reproduction-investigator")).toBe(true);
  expect(result.compiled.nodes.some((node) => node.id === "security-reviewer")).toBe(true);
  expect(result.compiled.nodeProvenance["security-reviewer"]?.source).toBe("overlay");
  expect(result.compiled.id).not.toBe("HIGH_RISK");
});

test("local reversible feature stays fast without critic", () => {
  const result = compileProfileFromContract(contract());
  expect(result.compiled.composition.executionBudget).toBe("fast");
  expect(result.compiled.nodes.filter((node) => node.role === "investigator")).toHaveLength(1);
  expect(result.compiled.nodes.some((node) => node.id === "plan-critic")).toBe(false);
  expect(result.compiled.nodes.some((node) => node.id === "planner")).toBe(false);
});

test("overlays add specialist nodes and emergency defers gates", () => {
  const emergency = compileProfileFromContract(
    contract({
      kind: "feature",
      riskFlags: ["emergency", "auth"],
      assumptions: [{ id: "a1", text: "rollback to previous release", reversible: true, evidence: [] }],
      inScope: ["src/a", "src/b", "src/c", "src/d"],
    }),
  );
  expect(emergency.compiled.nodes.some((node) => node.id === "security-reviewer")).toBe(true);
  expect(emergency.compiled.deferredGates).toContain("SPEC_CONSISTENCY");
  expect(emergency.compiled.composition.overlays).toContain("emergency");
});

test("research and diagnosis forbid write lease", () => {
  const research = selectWorkflowProfile({
    kind: "research",
    riskFlags: [],
    behaviorChange: false,
    localScope: true,
    reversible: true,
    noTests: false,
    unstableBug: false,
    multiSubsystem: false,
    externalResearch: false,
  });
  expect(research.compiled.forbiddenActions).toContain("write-lease");
  expect(research.compiled.nodes.some((node) => node.role === "implementer")).toBe(false);
  const diagnosis = compileRunComposition({
    composition: {
      ...composeFromSignals({
        kind: "research",
        riskFlags: [],
        behaviorChange: false,
        localScope: true,
        reversible: true,
        noTests: false,
        unstableBug: false,
        multiSubsystem: false,
        externalResearch: false,
      }),
      primaryIntent: "diagnosis",
      deliveryMode: "analysis-only",
    },
  });
  expect(diagnosis.compiled.forbiddenActions).toContain("implementer");
  expect(diagnosis.compiled.nodes.some((node) => node.id === "implementer")).toBe(false);
});

test("packs resolve through the project adapter", () => {
  const adapter = adapterWithPacks();
  const result = compileProfileFromContract(
    contract({
      objective: "fix xss in login ui",
      inScope: ["src/ui/login.tsx"],
      riskFlags: ["auth"],
    }),
    adapter,
  );
  expect(result.compiled.composition.verificationPacks).toEqual(
    expect.arrayContaining(["security", "web-ui"]),
  );
  const resolved = resolvedVerificationPacks(result.compiled.composition, adapter);
  expect(resolved.some((pack) => pack.id === "security")).toBe(true);
  expect(resolved.find((pack) => pack.id === "security")?.commands.commands[0]?.id).toBe("secret-scan");
});

test("incompatible work splits or blocks instead of mixed READY", () => {
  const researchImpl = composeFromContract(
    contract({
      kind: "research",
      specPolicy: { paths: ["specs"], behaviorChanges: true, updateRequired: false },
    }),
  );
  expect(researchImpl.composition.splitIntoRelatedRuns?.some((plan) => plan.relation === "implementation")).toBe(
    true,
  );
  const optimization = composeFromContract(
    contract({
      schemaVersion: 2,
      kind: "feature",
      primaryIntent: "optimization",
      secondaryIntents: [],
      objective: "make it faster",
      acceptanceCriteria: [
        {
          id: "ac1",
          statement: "it should feel nicer",
          verification: ["inspection"],
          requiredEvidence: ["review"],
        },
      ],
    }),
  );
  expect(optimization.composition.blockedReason).toBe(
    "optimization requires measurable acceptance criteria",
  );
  const blocked = compileProfileFromContract(
    contract({
      schemaVersion: 2,
      kind: "feature",
      primaryIntent: "optimization",
      secondaryIntents: [],
      objective: "make it faster",
      acceptanceCriteria: [
        {
          id: "ac1",
          statement: "it should feel nicer",
          verification: ["inspection"],
          requiredEvidence: ["review"],
        },
      ],
    }),
  );
  expect(blocked.blocked).toBe(true);
  expect(blocked.predicates).toContain("COMPOSITION_BLOCKED");
  const hotfix = composeFromContract(
    contract({
      kind: "bugfix",
      riskFlags: ["emergency"],
      assumptions: [{ id: "a1", text: "ship now", reversible: true, evidence: [] }],
    }),
  );
  expect(hotfix.composition.blockedReason).toBe("hotfix requires rollback evidence");
});
