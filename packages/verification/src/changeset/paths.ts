import { caseFoldKey, classifyRelativePath } from "@pi-hec/repository";
import { ChangeSetError } from "./errors.js";

export { caseFoldKey };

export function parentPath(path: string): string | undefined {
  const index = path.lastIndexOf("/");
  if (index === -1) {
    return undefined;
  }
  return path.slice(0, index);
}

export function basename(path: string): string {
  const index = path.lastIndexOf("/");
  if (index === -1) {
    return path;
  }
  return path.slice(index + 1);
}

export function isPrefixPath(prefix: string, other: string): boolean {
  return other === prefix || other.startsWith(`${prefix}/`);
}

export function simpleFold(text: string): string {
  return caseFoldKey(text, false);
}

export function namesCollide(left: string, right: string, caseSensitive: boolean): boolean {
  if (left === right) {
    return false;
  }
  if (left.normalize("NFC") === right.normalize("NFC")) {
    return true;
  }
  if (!caseSensitive && simpleFold(left) === simpleFold(right)) {
    return true;
  }
  return false;
}

export function caseOnlyRename(from: string, to: string, caseSensitive: boolean): boolean {
  if (from === to) {
    return false;
  }
  const fromParent = parentPath(from);
  const toParent = parentPath(to);
  if (fromParent !== toParent) {
    return false;
  }
  if (caseSensitive) {
    return false;
  }
  return simpleFold(basename(from)) === simpleFold(basename(to));
}

export function assertSafePath(
  path: string,
  role: string,
  options: { allowProtectedGit?: boolean } = {},
): void {
  const code = classifyRelativePath(path, options);
  if (code === undefined) {
    return;
  }
  switch (code) {
    case "PATH_TRAVERSAL":
      throw new ChangeSetError("PATH_TRAVERSAL", `${role} has an illegal path segment`);
    case "PATH_ABSOLUTE":
      throw new ChangeSetError("PATH_ABSOLUTE", `${role} is absolute or uses backslash`);
    case "PATH_DEVICE":
      throw new ChangeSetError("PATH_DEVICE", `${role} is a device or drive-relative path`);
    case "PATH_ADS":
      throw new ChangeSetError("PATH_ADS", `${role} contains ADS colon`);
    case "PATH_RESERVED":
      throw new ChangeSetError("PATH_RESERVED", `${role} uses a reserved or 8.3 name`);
    case "PATH_PROTECTED":
      throw new ChangeSetError("PATH_PROTECTED", `${role} touches protected .git`);
    case "PATH_LENGTH":
      throw new ChangeSetError("PATH_LENGTH", `${role} exceeds path length`);
    case "UNICODE_COLLISION":
      throw new ChangeSetError("UNICODE_COLLISION", `${role} is not NFC`);
    default: {
      const exhaustive: never = code;
      throw new ChangeSetError("PATH_TRAVERSAL", `unhandled path reject: ${String(exhaustive)}`);
    }
  }
}

export function assertSymlinkTargetContained(fromPath: string, target: string): string {
  if (target.includes("\0")) {
    throw new ChangeSetError("SYMLINK_ESCAPE", `symlink ${fromPath} target contains NUL`);
  }
  const normalized = target.normalize("NFC").replaceAll("\\", "/");
  if (normalized !== target.replaceAll("\\", "/").normalize("NFC")) {
    throw new ChangeSetError("SYMLINK_ESCAPE", `symlink ${fromPath} target is not NFC`);
  }
  if (normalized.startsWith("/") || normalized.startsWith("//") || normalized.includes(":")) {
    throw new ChangeSetError("SYMLINK_ESCAPE", `symlink ${fromPath} target is absolute/device/ADS`);
  }
  const classified = classifyRelativePath(normalized.replaceAll("\\", "/"));
  if (classified === "PATH_DEVICE") {
    throw new ChangeSetError("SYMLINK_ESCAPE", `symlink ${fromPath} target is absolute/device/ADS`);
  }
  const parent = parentPath(fromPath);
  const parts = parent === undefined ? [] : parent.split("/");
  for (const segment of normalized.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (parts.length === 0) {
        throw new ChangeSetError("SYMLINK_ESCAPE", `symlink ${fromPath} escapes the tree`);
      }
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return normalized;
}
