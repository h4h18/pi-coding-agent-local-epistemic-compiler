import {
  authenticatedScopeBrand,
  type PrincipalScope,
  type ProjectScope,
} from "@pi-hec/domain";
import { StoreLookupError } from "./errors.js";

export function hasProjectGrant(scope: PrincipalScope, projectId: string): boolean {
  return scope.projectGrants.some((grant) => grant.projectId === projectId);
}

export function toProjectScope(scope: PrincipalScope, projectId: string): ProjectScope {
  const grant = scope.projectGrants.find((entry) => entry.projectId === projectId);
  if (grant === undefined) {
    throw new StoreLookupError();
  }
  return {
    [authenticatedScopeBrand]: true,
    principalId: scope.principalId,
    identityKind: scope.identityKind,
    certificateSerial: scope.certificateSerial,
    audiences: scope.audiences,
    projectGrants: scope.projectGrants,
    authenticatedAt: scope.authenticatedAt,
    projectId,
    projectRoles: grant.roles,
    projectGrantObjectDigest: grant.grantObjectDigest,
  };
}

export function requireProjectId(scope: PrincipalScope, projectId: string): string {
  if (!hasProjectGrant(scope, projectId)) {
    throw new StoreLookupError();
  }
  return projectId;
}

export function scopedProjectId(scope: ProjectScope): string {
  if (!hasProjectGrant(scope, scope.projectId) || scope.projectId.length === 0) {
    throw new StoreLookupError();
  }
  return scope.projectId;
}
