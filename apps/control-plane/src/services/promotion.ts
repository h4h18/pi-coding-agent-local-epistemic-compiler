import type { ObjectDigest, PrincipalScope } from "@pi-hec/contracts";
import { persistCasArtifact, type AppContext } from "../orchestration/handlers.js";

export async function recordApplyReceipt(
  ctx: AppContext,
  scope: PrincipalScope,
  projectId: string,
  bytes: Uint8Array,
): Promise<ObjectDigest> {
  return persistCasArtifact(ctx, scope, projectId, bytes, "application/json", "internal", "ApplyReceipt");
}
