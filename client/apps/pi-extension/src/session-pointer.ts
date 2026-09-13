import type { ObjectDigest, RunId, RunProjection } from "@pi-hec/contracts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const HEC_RUN_POINTER_TYPE = "hec-run-pointer";
export const COMPATIBILITY_UNCONFINED = "COMPATIBILITY_UNCONFINED";

export type SecurityMode = "production" | "compatibility";

export type HecUiPreferences = {
  hecModeEnabled: boolean;
  securityMode: SecurityMode;
  roleIsolationClaimed: boolean;
  confinementMark: typeof COMPATIBILITY_UNCONFINED | null;
  workspaceAlias: string;
};

export type HecRunPointer = {
  activeRunId: RunId | null;
  controlEndpointIdentity: string;
  lastDisplayedEventSequence: number;
  uiPreferences: HecUiPreferences;
};

export type ConfinementAssessment = {
  confined: boolean;
};

export function defaultConfinementProbe(): ConfinementAssessment {
  return { confined: false };
}

export function emptyPointer(input: {
  controlEndpointIdentity: string;
  securityMode: SecurityMode;
  workspaceAlias: string;
  confined: boolean;
}): HecRunPointer {
  const compatibility = !input.confined;
  return {
    activeRunId: null,
    controlEndpointIdentity: input.controlEndpointIdentity,
    lastDisplayedEventSequence: 0,
    uiPreferences: {
      hecModeEnabled: false,
      securityMode: input.securityMode,
      roleIsolationClaimed: input.confined && input.securityMode === "production",
      confinementMark: compatibility ? COMPATIBILITY_UNCONFINED : null,
      workspaceAlias: input.workspaceAlias,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readUint(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function isRunId(value: string): value is RunId {
  return value.startsWith("run_");
}

export function isObjectDigest(value: string): value is ObjectDigest {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

export function parsePointer(data: unknown): HecRunPointer | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const prefs = data.uiPreferences;
  if (!isRecord(prefs)) {
    return undefined;
  }
  const securityMode = readString(prefs.securityMode);
  if (securityMode !== "production" && securityMode !== "compatibility") {
    return undefined;
  }
  const hecModeEnabled = readBoolean(prefs.hecModeEnabled);
  const roleIsolationClaimed = readBoolean(prefs.roleIsolationClaimed);
  const workspaceAlias = readString(prefs.workspaceAlias);
  const controlEndpointIdentity = readString(data.controlEndpointIdentity);
  const lastDisplayedEventSequence = readUint(data.lastDisplayedEventSequence);
  if (
    hecModeEnabled === undefined ||
    roleIsolationClaimed === undefined ||
    workspaceAlias === undefined ||
    controlEndpointIdentity === undefined ||
    lastDisplayedEventSequence === undefined
  ) {
    return undefined;
  }
  const mark = prefs.confinementMark;
  if (mark !== null && mark !== COMPATIBILITY_UNCONFINED) {
    return undefined;
  }
  const activeRunId = data.activeRunId;
  if (activeRunId !== null && (typeof activeRunId !== "string" || !isRunId(activeRunId))) {
    return undefined;
  }
  return {
    activeRunId: activeRunId === null ? null : activeRunId,
    controlEndpointIdentity,
    lastDisplayedEventSequence,
    uiPreferences: {
      hecModeEnabled,
      securityMode,
      roleIsolationClaimed,
      confinementMark: mark,
      workspaceAlias,
    },
  };
}

export function latestPointer(entries: readonly SessionEntry[]): HecRunPointer | undefined {
  let found: HecRunPointer | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === HEC_RUN_POINTER_TYPE) {
      const parsed = parsePointer(entry.data);
      if (parsed !== undefined) {
        found = parsed;
      }
    }
  }
  return found;
}

export function firstDigestForRole(run: RunProjection, role: string): ObjectDigest | undefined {
  const match = run.artifactRoles.find((entry) => entry.role === role);
  const digest = match?.objectDigests[match.objectDigests.length - 1];
  return digest !== undefined && isObjectDigest(digest) ? digest : undefined;
}

export function workspaceAliasFromCwd(cwd: string): string {
  const trimmed = cwd.replaceAll("\\", "/").replace(/\/+$/u, "");
  const parts = trimmed.split("/");
  const last = parts[parts.length - 1];
  return last !== undefined && last.length > 0 ? last : "workspace";
}
