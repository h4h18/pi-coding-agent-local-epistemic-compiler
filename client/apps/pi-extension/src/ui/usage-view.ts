import type { RunProjection } from "@pi-hec/contracts";
import {
  emptyUsageProjection,
  formatUsageLines,
  type UsageProjection,
  type UsageScopeKind,
} from "@pi-hec/usage";
import { escapeUntrustedText } from "./status-widget.js";

export const USAGE_EXPORT_VIEW = "EXPORT" as const;

export type UsageScope = UsageScopeKind;
export type { UsageProjection };

export function parseUsageScope(token: string | undefined): UsageScope {
  switch (token) {
    case "session":
    case "day":
    case "project":
      return token;
    case undefined:
    case "run":
      return "run";
    default:
      return "run";
  }
}

export function renderUsageView(input: {
  scope: UsageScope;
  run: RunProjection | undefined;
  projection?: UsageProjection;
}): string[] {
  const projection = input.projection ?? emptyUsageProjection(input.scope);
  return formatUsageLines({
    scope: input.scope,
    runId: input.run?.runId ?? "none",
    state: input.run?.state ?? "UNKNOWN",
    projection,
  }).map((line) => escapeUntrustedText(line));
}
