import type { StateStore } from "@pi-hec/state-store";
import { toUsageInput } from "./normalize.js";

export const packageName = "@pi-hec/usage";

export { normalizeProviderUsage, toUsageInput } from "./normalize.js";
export type { ProviderUsageDraft } from "./normalize.js";

export { applyPricing, snapshotPricing } from "./pricing.js";
export type { PricingSnapshot } from "./pricing.js";

export {
  emptyUsageProjection,
  formatUsageLines,
  loadUsageLedger,
  projectUsage,
  uniqueLeaves,
} from "./projections.js";
export type {
  CloudCallOutcome,
  UsageFilter,
  UsageLedgerEntry,
  UsageProjection,
  UsageScopeKind,
} from "./projections.js";

export {
  CLASSIFICATION_DENIAL,
  buildExportManifest,
  classificationRank,
  filterExportableArtifacts,
  isClassificationPermitted,
} from "./export.js";
export type { ArtifactClassification, ExportManifest, ExportableArtifact } from "./export.js";

export function persistNormalizedUsage(
  store: Pick<StateStore, "appendUsage">,
  scope: Parameters<StateStore["appendUsage"]>[0],
  input: Parameters<typeof toUsageInput>[0],
): void {
  store.appendUsage(scope, toUsageInput(input));
}
