import type { ApiAudience, HttpOperationSpec, PrincipalScope } from "@pi-hec/contracts";

export type AuthorizationDecision =
  | { kind: "allow"; projectId: string | undefined }
  | { kind: "unauthenticated" }
  | { kind: "not_found" };

function pathProjectId(params: Readonly<Record<string, string>> | undefined): string | undefined {
  const projectId = params?.projectId;
  if (projectId === undefined || projectId.length === 0) {
    return undefined;
  }
  return projectId;
}

function audienceAllowed(scope: PrincipalScope, audiences: readonly ApiAudience[]): boolean {
  for (const audience of audiences) {
    switch (audience) {
      case "admin":
        if (scope.identityKind === "admin" && scope.audiences.includes("admin")) {
          return true;
        }
        break;
      case "broker":
        if (scope.identityKind === "broker" && scope.audiences.includes("broker")) {
          return true;
        }
        break;
      case "runner":
        if (scope.identityKind === "runner" && scope.audiences.includes("runner")) {
          return true;
        }
        break;
      case "worker":
        if (scope.identityKind === "worker" && scope.audiences.includes("worker")) {
          return true;
        }
        break;
      case "owning-runner":
        if (scope.identityKind === "runner" && scope.audiences.includes("runner")) {
          return true;
        }
        break;
      case "bootstrap":
        break;
      default: {
        const exhaustive: never = audience;
        throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  return false;
}

function hasProjectAccess(scope: PrincipalScope, projectId: string): boolean {
  return scope.projectGrants.some((grant) => grant.projectId === projectId);
}

export function authorizeOperation(input: {
  scope: PrincipalScope | undefined;
  operation: HttpOperationSpec;
  params?: Readonly<Record<string, string>>;
}): AuthorizationDecision {
  const projectId = pathProjectId(input.params);
  if (input.operation.audiences.includes("bootstrap")) {
    if (input.scope !== undefined) {
      return { kind: "not_found" };
    }
    return { kind: "allow", projectId };
  }
  if (input.scope === undefined) {
    return { kind: "unauthenticated" };
  }
  if (!audienceAllowed(input.scope, input.operation.audiences)) {
    return { kind: "not_found" };
  }
  if (projectId !== undefined && !hasProjectAccess(input.scope, projectId)) {
    return { kind: "not_found" };
  }
  return { kind: "allow", projectId };
}

export function isOwningRunnerAudience(operation: HttpOperationSpec): boolean {
  return operation.audiences.includes("owning-runner");
}
