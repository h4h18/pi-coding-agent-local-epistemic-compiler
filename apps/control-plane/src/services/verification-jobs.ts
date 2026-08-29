import type { ObjectDigest, PrincipalScope } from "@pi-hec/contracts";
import type { OperationRecord } from "@pi-hec/state-store";
import type { AppContext } from "../orchestration/handlers.js";

export type VerificationOperationKind = "MATERIALIZE_CANDIDATE" | "PLAN_VERIFICATION" | "RUN_VERIFICATION_CHECK";

export function enqueueVerificationOperation(
  ctx: AppContext,
  scope: PrincipalScope,
  input: {
    projectId: string;
    runId: string;
    operationKind: VerificationOperationKind;
    operationId: string;
    inputDigest: ObjectDigest;
  },
): OperationRecord {
  const projectScope = ctx.store.toProjectScope(scope, input.projectId);
  const record = ctx.store.enqueueOperation(projectScope, {
    operationId: input.operationId,
    runId: input.runId,
    operationKind: input.operationKind,
    dedupeKey: `${input.operationKind}:${input.runId}`,
    inputDigest: input.inputDigest,
    createdAt: ctx.clock(),
  });
  ctx.scheduler.notifyWork();
  return record;
}
