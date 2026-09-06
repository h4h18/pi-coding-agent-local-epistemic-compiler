import { NormalizedPathSchema } from "@pi-hec/contracts";
import { Compile } from "typebox/compile";

const PATH = Compile(NormalizedPathSchema);

const FORBIDDEN_PARAM_NAMES = new Set([
  "command",
  "argv",
  "cwd",
  "patch",
  "content",
  "fileContent",
  "url",
]);

export function assertNoForbiddenParamNames(params: unknown): void {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("tool parameters must be an object");
  }
  for (const key of Object.keys(params)) {
    if (FORBIDDEN_PARAM_NAMES.has(key)) {
      throw new Error(`tool parameter ${key} is forbidden`);
    }
  }
}

export function assertSnapshotRelativePath(
  snapshotPaths: ReadonlySet<string>,
  relativePath: string,
): string {
  const normalized = relativePath.normalize("NFC");
  if (!PATH.Check(normalized) || !snapshotPaths.has(normalized)) {
    throw new Error(`path is not a snapshot-relative member: ${relativePath}`);
  }
  return normalized;
}

export function assertSnapshotPrefix(snapshotPaths: ReadonlySet<string>, prefix: string): string {
  const normalized = prefix.normalize("NFC");
  if (!PATH.Check(normalized)) {
    throw new Error(`path is not a snapshot-relative member: ${prefix}`);
  }
  if (snapshotPaths.has(normalized)) {
    return normalized;
  }
  const dirPrefix = `${normalized}/`;
  for (const member of snapshotPaths) {
    if (member.startsWith(dirPrefix)) {
      return normalized;
    }
  }
  throw new Error(`path is not a snapshot-relative member: ${prefix}`);
}
