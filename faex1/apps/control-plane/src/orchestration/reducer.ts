import type { PrincipalScope } from "@pi-hec/contracts";
import type { PersistRunEventInput, StateStore } from "@pi-hec/state-store";

export function persistDomainEvent(
  store: StateStore,
  scope: PrincipalScope,
  projectId: string,
  input: PersistRunEventInput,
) {
  const projectScope = store.toProjectScope(scope, projectId);
  return store.persistRunEvent(projectScope, input);
}
