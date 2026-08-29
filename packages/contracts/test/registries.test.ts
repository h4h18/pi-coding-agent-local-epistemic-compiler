import { expect, test } from "vitest";
import { DIGEST_PROJECTION_REGISTRY } from "../src/generated/digest-projections.js";
import { ARTIFACT_ROLE_REGISTRY } from "../src/generated/artifact-roles.js";
import {
  RUN_STATES,
  TERMINAL_RUN_STATES,
  type RunState,
} from "../src/generated/run-states.js";
import { phaseTransitions } from "../src/generated/phase-transitions.js";
import { RUN_EVENT_REGISTRY } from "../src/generated/run-event-registry.js";
import { STATE_INVARIANTS } from "../src/generated/state-invariants.js";
import { SIGNER_REGISTRY } from "../src/generated/signer-registry.js";
import { HTTP_OPERATIONS } from "../src/schemas/http-operations.js";
import { generateOpenApiDocument } from "../src/openapi.js";
import {
  artifactRoleRegistrySql,
  operationKindRegistrySql,
  runStateRegistrySql,
} from "../src/generated/sql-seeds.js";

test("digest projection registry has the complete revision 1 domain set", () => {
  expect(DIGEST_PROJECTION_REGISTRY).toHaveLength(26);
  expect(new Set(DIGEST_PROJECTION_REGISTRY.map((entry) => entry.domain)).size).toBe(26);
});

test("every RunState has a phaseTransitions entry", () => {
  for (const state of RUN_STATES) {
    expect(phaseTransitions[state]).toBeDefined();
  }
});

test("run-event registry keys are unique and ENTER targets match", () => {
  const keys = Object.keys(RUN_EVENT_REGISTRY);
  expect(new Set(keys).size).toBe(keys.length);
  for (const contract of Object.values(RUN_EVENT_REGISTRY)) {
    if (contract.eventType.startsWith("ENTER_")) {
      expect(contract.eventType).toBe(`ENTER_${contract.targetState}`);
    }
  }
});

test("artifact role primary keys are unique", () => {
  const keys = ARTIFACT_ROLE_REGISTRY.map((entry) => `${entry.ownerKind}\0${entry.role}`);
  expect(new Set(keys).size).toBe(keys.length);
});

test("every state-invariant role is registered", () => {
  const registered = new Set(ARTIFACT_ROLE_REGISTRY.map((entry) => entry.role));
  for (const entry of STATE_INVARIANTS) {
    for (const role of entry.requiredRoles) {
      expect(registered.has(role), `${entry.state} ${role}`).toBe(true);
    }
    for (const set of entry.alternativeRoleSets ?? []) {
      for (const role of set) {
        expect(registered.has(role), `${entry.state} alt ${role}`).toBe(true);
      }
    }
  }
});

test("SQL seeds contain every run state and operation kind", () => {
  const stateSql = runStateRegistrySql();
  for (const state of RUN_STATES) {
    expect(stateSql).toContain(`('${state}')`);
  }
  expect(operationKindRegistrySql()).toContain("CAPTURE_SNAPSHOT");
  expect(artifactRoleRegistrySql()).toContain("task-envelope");
  expect(artifactRoleRegistrySql()).toContain("cancellation-request");
  expect(artifactRoleRegistrySql()).toContain("suspended-state-binding");
  expect(artifactRoleRegistrySql()).toContain("'transport-evidence'");
});

test("OpenAPI 3.1 paths cover the HTTP operation matrix", () => {
  const document = generateOpenApiDocument();
  expect(document.openapi).toBe("3.1.0");
  expect(document.jsonSchemaDialect).toBe("https://json-schema.org/draft/2020-12/schema");
  for (const operation of HTTP_OPERATIONS) {
    expect(document.paths[operation.path]?.[operation.method.toLowerCase()]?.operationId).toBe(
      operation.operationId,
    );
  }
});

test("global cancellation and failure are registered from every interruptible nonterminal", () => {
  const nonInterruptible = new Set<RunState>([
    ...TERMINAL_RUN_STATES,
    "APPLY_PREPARING",
    "APPLYING",
    "APPLY_RECONCILING",
    "CANCELLATION_PENDING",
  ]);
  for (const state of RUN_STATES) {
    if (nonInterruptible.has(state)) {
      continue;
    }
    const cancel = RUN_EVENT_REGISTRY[`${state}\0USER_CANCELLATION_REQUESTED`];
    expect(cancel, `cancel from ${state}`).toMatchObject({
      sourceState: state,
      eventType: "USER_CANCELLATION_REQUESTED",
      targetState: "CANCELLATION_PENDING",
      allowedActorTypes: ["user"],
    });
    expect(cancel.guardIds).toContain("CANCELLATION_INTERRUPTIBLE");
    const failure = RUN_EVENT_REGISTRY[`${state}\0UNRECOVERABLE_PLATFORM_FAILURE`];
    expect(failure, `failure from ${state}`).toMatchObject({
      sourceState: state,
      eventType: "UNRECOVERABLE_PLATFORM_FAILURE",
      targetState: "FAILED",
      allowedActorTypes: ["control", "broker"],
    });
  }
  expect(RUN_EVENT_REGISTRY["SNAPSHOT_READY\0USER_CANCELLATION_REQUESTED"]).toBeDefined();
  expect(RUN_EVENT_REGISTRY["CREATED\0USER_CANCELLATION_REQUESTED"]).toBeDefined();
  expect(RUN_EVENT_REGISTRY["SUCCEEDED\0USER_CANCELLATION_REQUESTED"]).toBeUndefined();
  expect(RUN_EVENT_REGISTRY["APPLYING\0USER_CANCELLATION_REQUESTED"]).toBeUndefined();
  const settled = RUN_EVENT_REGISTRY["CANCELLATION_PENDING\0CANCELLATION_SETTLED"];
  expect(settled).toMatchObject({
    targetState: "CANCELLED",
    allowedActorTypes: ["control", "broker"],
  });
  const unknown = RUN_EVENT_REGISTRY["CANCELLATION_PENDING\0CANCELLATION_OUTCOME_UNKNOWN"];
  expect(unknown).toMatchObject({
    targetState: "CLOUD_OUTCOME_UNKNOWN",
    allowedActorTypes: ["control", "broker"],
  });
});

test("CLOUD_RECOVERY_DECISION_VALID covers provider, unknown, and dispatch cancellation", () => {
  const prepared = RUN_EVENT_REGISTRY["WAITING_PROVIDER\0ENTER_CLOUD_PREPARED"];
  expect(prepared.guardIds).toContain("CLOUD_RECOVERY_DECISION_VALID");
  for (const target of phaseTransitions.CLOUD_OUTCOME_UNKNOWN) {
    const contract = RUN_EVENT_REGISTRY[`CLOUD_OUTCOME_UNKNOWN\0ENTER_${target}`];
    expect(contract.guardIds).toContain("CLOUD_RECOVERY_DECISION_VALID");
  }
  expect(
    RUN_EVENT_REGISTRY["CLOUD_DISPATCHING\0ENTER_CLOUD_OUTCOME_UNKNOWN"].guardIds,
  ).toContain("CLOUD_RECOVERY_DECISION_VALID");
  expect(
    RUN_EVENT_REGISTRY["CLOUD_IN_FLIGHT\0ENTER_CLOUD_OUTCOME_UNKNOWN"].guardIds,
  ).toContain("CLOUD_RECOVERY_DECISION_VALID");
});

function invariantByState(state: RunState) {
  const entry = STATE_INVARIANTS.find((item) => item.state === state);
  if (entry === undefined) {
    throw new Error(`missing state invariant for ${state}`);
  }
  return entry;
}

function invariantRoleSets(state: RunState): readonly (readonly string[])[] {
  const entry = invariantByState(state);
  return entry.alternativeRoleSets ?? [entry.requiredRoles];
}

test("state-invariants registry has exactly one entry per RunState", () => {
  expect(STATE_INVARIANTS).toHaveLength(RUN_STATES.length);
  expect(new Set(STATE_INVARIANTS.map((entry) => entry.state)).size).toBe(RUN_STATES.length);
  const byState = Object.fromEntries(STATE_INVARIANTS.map((entry) => [entry.state, entry]));
  expect(byState.SNAPSHOT_READY.requiredRoles).toEqual(
    expect.arrayContaining(["snapshot-manifest"]),
  );
  expect(byState.BASELINE_SEALED.requiredRoles).toEqual(
    expect.arrayContaining([
      "requirement-ledger",
      "instruction-manifest",
      "skill-manifest",
      "environment-seal",
      "baseline-seal",
    ]),
  );
  expect(byState.SUCCEEDED.alternativeRoleSets).toBeDefined();
});

test("CANCELLATION_PENDING requires request and suspended-state binding, not receipt", () => {
  const pending = invariantByState("CANCELLATION_PENDING");
  expect(pending.requiredRoles).toEqual(
    expect.arrayContaining(["cancellation-request", "suspended-state-binding"]),
  );
  expect(pending.requiredRoles).not.toContain("cancellation-receipt");
  for (const roles of invariantRoleSets("CANCELLATION_PENDING")) {
    expect(roles).not.toContain("cancellation-receipt");
    expect(roles).toEqual(
      expect.arrayContaining(["cancellation-request", "suspended-state-binding"]),
    );
  }
  expect(invariantByState("CANCELLED").requiredRoles).toContain("cancellation-receipt");
  for (const role of ["cancellation-request", "suspended-state-binding"] as const) {
    const entry = ARTIFACT_ROLE_REGISTRY.find(
      (item) => item.ownerKind === "run" && item.role === role,
    );
    expect(entry, role).toMatchObject({ artifactSchemaName: null });
  }
});

test("CLOUD_OUTCOME_UNKNOWN treats transport and cancellation evidence as alternatives", () => {
  const unknown = invariantByState("CLOUD_OUTCOME_UNKNOWN");
  expect(unknown.requiredRoles).toEqual(expect.arrayContaining(["canonical-cloud-request"]));
  expect(unknown.requiredRoles).not.toContain("cancellation-receipt");
  const sets = invariantRoleSets("CLOUD_OUTCOME_UNKNOWN");
  expect(sets.some((roles) => roles.includes("transport-evidence"))).toBe(true);
  expect(sets.some((roles) => roles.includes("cancellation-receipt"))).toBe(true);
  expect(sets.every((roles) => roles.includes("cancellation-receipt"))).toBe(false);
  expect(
    sets.some(
      (roles) => roles.includes("transport-evidence") && !roles.includes("cancellation-receipt"),
    ),
  ).toBe(true);
});

test("AWAITING_DUPLICATE_CALL_APPROVAL requires unknown-outcome evidence and risk display, not receipt", () => {
  const awaiting = invariantByState("AWAITING_DUPLICATE_CALL_APPROVAL");
  expect(awaiting.requiredRoles).toEqual(
    expect.arrayContaining(["transport-evidence", "approval-subject"]),
  );
  expect(awaiting.requiredRoles).not.toContain("cancellation-receipt");
  for (const roles of invariantRoleSets("AWAITING_DUPLICATE_CALL_APPROVAL")) {
    expect(roles).not.toContain("cancellation-receipt");
    expect(roles).toEqual(expect.arrayContaining(["transport-evidence", "approval-subject"]));
  }
});

test("CONTEXT_COMPILING is cumulative over PREFLIGHT_COMPLETE including evidence-graph", () => {
  const compiling = invariantByState("CONTEXT_COMPILING");
  const preflight = invariantByState("PREFLIGHT_COMPLETE");
  expect(compiling.requiredRoles).toEqual(expect.arrayContaining([...preflight.requiredRoles]));
  expect(compiling.requiredRoles).toEqual(
    expect.arrayContaining(["evidence-graph", "closure-report", "baseline-seal"]),
  );
});

test("verification-evidence-root is a domain digest role not EvidenceRecord", () => {
  const role = ARTIFACT_ROLE_REGISTRY.find((entry) => entry.role === "verification-evidence-root");
  expect(role?.artifactSchemaName).not.toBe("EvidenceRecord");
});

test("snapshot-root projection excludes platform identity fields", () => {
  const snapshotRoot = DIGEST_PROJECTION_REGISTRY.find((entry) => entry.domain === "snapshot-root");
  expect(snapshotRoot?.includedFields).toEqual([
    "repositoryId",
    "workspaceId",
    "gitHead",
    "gitIndexDigest",
    "gitHistoryRootDigest",
    "dirty",
    "filesystem",
    "entries",
    "ignoredPathDigests",
    "excludedPaths",
  ]);
  expect(snapshotRoot?.includedFields).not.toContain("platform");
  expect(snapshotRoot?.includedFields).not.toContain("snapshotId");
  expect(snapshotRoot?.includedFields).not.toContain("createdAt");
  expect(snapshotRoot?.includedFields).not.toContain("runnerId");
  expect(snapshotRoot?.includedFields).not.toContain("rootDigest");
  expect(snapshotRoot).toBeDefined();
  if (snapshotRoot === undefined || !("nestedIncludedFields" in snapshotRoot)) {
    throw new Error("snapshot-root nestedIncludedFields missing");
  }
  expect(snapshotRoot.nestedIncludedFields.filesystem).toEqual([
    "rootChildNameComparison",
    "unicodeNormalization",
    "unicodeSimpleFoldTableObjectDigest",
    "pathGlobDialect",
    "volumeIdentity",
  ]);
});

test("signer registry matches section 10 authority artifacts only", () => {
  const names = SIGNER_REGISTRY.map((entry) => entry.schemaName);
  expect(names).not.toContain("ApprovalDisplayArtifact");
  expect(names).not.toContain("BrokerCancellationReceipt");
  expect(names).toContain("ProjectPolicy");
  expect(names).toContain("ApprovalSubject");
  expect(names).toContain("CanonicalCloudRequest");
  expect(names).toContain("ApprovalGrant");
  expect(names).toContain("ApprovalDecision");
  expect(new Set(names).size).toBe(names.length);
});

