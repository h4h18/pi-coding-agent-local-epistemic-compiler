import { resolve, sep } from "node:path";
import type { WorkspaceLease } from "@pi-hec/contracts";

export class WorkspaceIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceIsolationError";
  }
}

const PROTECTED = [".env", ".git", "id_rsa", "id_ed25519", ".npmrc"];

export function assertLeaseWritable(lease: WorkspaceLease): void {
  if (!lease.isolationVerified) {
    throw new WorkspaceIsolationError("writer requires isolationVerified lease");
  }
}

export function resolveInsideLease(lease: WorkspaceLease, relativePath: string): string {
  if (
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    relativePath.startsWith("/") ||
    relativePath.split("/").some((segment) => segment === ".." || segment === "." || segment === "")
  ) {
    throw new WorkspaceIsolationError("path must be repository-relative");
  }
  const overlay = resolve(lease.overlayPath);
  const target = resolve(overlay, relativePath);
  if (target !== overlay && !target.startsWith(overlay + sep)) {
    throw new WorkspaceIsolationError("path escapes overlay");
  }
  if (PROTECTED.some((item) => relativePath === item || relativePath.startsWith(`${item}/`))) {
    throw new WorkspaceIsolationError("protected path");
  }
  if (
    lease.allowedPaths.length > 0 &&
    !lease.allowedPaths.some((allowed) => relativePath === allowed || relativePath.startsWith(`${allowed}/`))
  ) {
    throw new WorkspaceIsolationError("path outside lease scope");
  }
  return target;
}

export function assertCwdInsideLease(lease: WorkspaceLease, cwd: string): void {
  const overlay = resolve(lease.overlayPath);
  const actual = resolve(cwd);
  if (actual !== overlay && !actual.startsWith(overlay + sep)) {
    throw new WorkspaceIsolationError("cwd outside overlay");
  }
}

export function verifyLease(lease: WorkspaceLease, userTree: string): void {
  const overlay = resolve(lease.overlayPath);
  const user = resolve(userTree);
  if (overlay === user) {
    throw new WorkspaceIsolationError("overlay must not be user working tree");
  }
  if (!lease.isolationVerified) {
    throw new WorkspaceIsolationError("sandbox backend has not verified isolation");
  }
}
