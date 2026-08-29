import type { ObjectDigest, PrincipalScope } from "@pi-hec/contracts";
import { RECLAIMABLE_OPERATION_KINDS } from "@pi-hec/domain";
import type { StateStore } from "@pi-hec/state-store";

export type RecoveryReport = {
  succeededSkipped: number;
  reclaimable: number;
  markedUnknown: number;
};

export function recoverOperations(input: {
  store: StateStore;
  adminScope: PrincipalScope;
  now: string;
  errorDigest: ObjectDigest;
}): RecoveryReport {
  const rows = input.store.scanOperations();
  let succeededSkipped = 0;
  let reclaimable = 0;
  let markedUnknown = 0;
  for (const row of rows) {
    switch (row.state) {
      case "succeeded":
      case "cancelled":
        succeededSkipped += 1;
        break;
      case "ready":
        reclaimable += 1;
        break;
      case "failed":
        if (row.reclaimable) {
          reclaimable += 1;
        }
        break;
      case "leased": {
        const expired = row.leaseUntil !== undefined && input.now > row.leaseUntil;
        let reclaimableKind = false;
        for (const kind of RECLAIMABLE_OPERATION_KINDS) {
          if (kind === row.operationKind) {
            reclaimableKind = true;
            break;
          }
        }
        if (expired && (row.reclaimable || reclaimableKind)) {
          reclaimable += 1;
          break;
        }
        if (expired && !row.reclaimable) {
          const scope = input.store.toProjectScope(input.adminScope, row.projectId);
          input.store.markOperationUnknown(scope, {
            operationId: row.operationId,
            errorDigest: input.errorDigest,
            updatedAt: input.now,
          });
          markedUnknown += 1;
        }
        break;
      }
      case "unknown":
        markedUnknown += 1;
        break;
      default: {
        const exhaustive: never = row.state as never;
        throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  return { succeededSkipped, reclaimable, markedUnknown };
}
