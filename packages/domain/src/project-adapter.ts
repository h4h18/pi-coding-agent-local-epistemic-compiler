import { Compile } from "typebox/compile";
import { ProjectAdapterSchema, type ProjectAdapter } from "@pi-hec/contracts";

const ADAPTER = Compile(ProjectAdapterSchema);

const IMMUTABLE_DEFAULTS = {
  networkDefault: "deny",
  nestedDelegation: false,
  applyToUserTree: "explicit",
} as const;

export type ProjectLock = {
  adapter: ProjectAdapter;
  tightened: boolean;
};

export function validateProjectAdapter(value: unknown): ProjectAdapter {
  if (!ADAPTER.Check(value)) {
    throw new Error("project adapter failed schema");
  }
  if (value.network.default !== IMMUTABLE_DEFAULTS.networkDefault) {
    throw new Error("project adapter cannot weaken network default");
  }
  return value;
}

export function lockProjectAdapter(candidate: unknown | undefined): ProjectLock {
  if (candidate === undefined) {
    return {
      adapter: {
        schemaVersion: 1,
        project: { id: "auto", adapter: "auto" },
        spec: { roots: ["specs"], behaviorChangeRequiresUpdate: true },
        verification: { baseline: [], targeted: [], final: [] },
        protectedPaths: [".env*", ".git/**"],
        network: { default: "deny", externalResearch: "deny" },
      },
      tightened: false,
    };
  }
  return { adapter: validateProjectAdapter(candidate), tightened: true };
}

export function mergeTightening(base: ProjectAdapter, overlay: ProjectAdapter): ProjectAdapter {
  return {
    schemaVersion: 1,
    project: overlay.project,
    spec: {
      roots: [...new Set([...base.spec.roots, ...overlay.spec.roots])],
      behaviorChangeRequiresUpdate:
        base.spec.behaviorChangeRequiresUpdate || overlay.spec.behaviorChangeRequiresUpdate,
    },
    verification: {
      baseline: [...base.verification.baseline, ...overlay.verification.baseline],
      targeted: [...base.verification.targeted, ...overlay.verification.targeted],
      final: [...base.verification.final, ...overlay.verification.final],
    },
    protectedPaths: [...new Set([...base.protectedPaths, ...overlay.protectedPaths])],
    network: {
      default: "deny",
      externalResearch:
        base.network.externalResearch === "deny" || overlay.network.externalResearch === "deny"
          ? "deny"
          : "allow",
    },
  };
}
