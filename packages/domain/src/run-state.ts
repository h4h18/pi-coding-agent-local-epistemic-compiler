import {
  ARTIFACT_ROLE_REGISTRY,
  STATE_INVARIANTS,
  type ObjectDigest,
  type RunGuardId,
  type RunId,
  type RunProjection,
  type RunState,
} from "@pi-hec/contracts";

export type { RunProjection, RunState };

export type VerifiedArtifactBinding = {
  readonly role: string;
  readonly objectDigest: ObjectDigest;
};

export type VerifiedArtifactSet = {
  readonly bindings: readonly VerifiedArtifactBinding[];
  readonly signaturesValid: boolean;
  readonly satisfiedGuards: ReadonlySet<RunGuardId>;
};

export function legalRoleSets(state: RunState): readonly (readonly string[])[] {
  const invariant = STATE_INVARIANTS.find((entry) => entry.state === state);
  if (invariant === undefined) {
    throw new Error(`missing state invariant for ${state}`);
  }
  return invariant.alternativeRoleSets ?? [invariant.requiredRoles];
}

export function artifactRolesSatisfyState(
  presentRoles: ReadonlySet<string>,
  state: RunState,
): boolean {
  return legalRoleSets(state).some((set) => set.every((role) => presentRoles.has(role)));
}

export function presentRolesOf(artifacts: VerifiedArtifactSet): Set<string> {
  return new Set(artifacts.bindings.map((binding) => binding.role));
}

export function projectionArtifactRoles(
  artifacts: VerifiedArtifactSet,
): RunProjection["artifactRoles"] {
  const grouped = new Map<string, ObjectDigest[]>();
  for (const binding of artifacts.bindings) {
    const digests = grouped.get(binding.role) ?? [];
    digests.push(binding.objectDigest);
    grouped.set(binding.role, digests);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([role, objectDigests]) => {
      const registered = ARTIFACT_ROLE_REGISTRY.find((entry) => entry.role === role);
      if (registered === undefined) {
        throw new Error(`unknown artifact role ${role}`);
      }
      return {
        role,
        cardinality: registered.cardinality,
        objectDigests,
      };
    });
}

export function createRunProjection(input: {
  projectId: string;
  runId: RunId;
  workspaceId: string;
  occurredAt: string;
  taskEnvelopeDigest: ObjectDigest;
}): RunProjection {
  return {
    schemaVersion: 1,
    projectId: input.projectId,
    runId: input.runId,
    workspaceId: input.workspaceId,
    state: "CREATED",
    stateVersion: 0,
    artifactRoles: [
      {
        role: "task-envelope",
        cardinality: "EXACTLY_ONE",
        objectDigests: [input.taskEnvelopeDigest],
      },
    ],
    updatedAt: input.occurredAt,
  };
}
