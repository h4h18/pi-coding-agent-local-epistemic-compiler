import type { ChangeOperation } from "@pi-hec/contracts";
import { ChangeSetError } from "./errors.js";
import { caseFoldKey, caseOnlyRename, isPrefixPath } from "./paths.js";

function operationPaths(operation: ChangeOperation): readonly string[] {
  switch (operation.kind) {
    case "text_patch":
    case "create_text":
    case "create_directory":
    case "write_binary":
    case "delete":
    case "delete_directory":
    case "set_git_mode":
    case "symlink":
      return [operation.path];
    case "move":
      return [operation.from, operation.to];
    default: {
      const exhaustive: never = operation;
      throw new ChangeSetError(
        "UNHANDLED_OPERATION",
        `unhandled union: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

function kindsEqual(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) {
    return false;
  }
  return actual.every((kind, index) => kind === expected[index]);
}

function isCanonicalKindChain(kinds: readonly string[]): boolean {
  if (kinds.length <= 1) {
    return true;
  }
  return (
    kindsEqual(kinds, ["move", "text_patch", "set_git_mode"]) ||
    kindsEqual(kinds, ["move", "text_patch"]) ||
    kindsEqual(kinds, ["text_patch", "set_git_mode"])
  );
}

export function assertCanonicalChains(
  operations: readonly ChangeOperation[],
  caseSensitive: boolean,
): void {
  const kindsByPath = new Map<string, string[]>();
  for (const operation of operations) {
    if (operation.kind === "move") {
      if (operation.from === operation.to) {
        throw new ChangeSetError("CHAIN_AMBIGUOUS", "move source and destination are identical");
      }
      if (
        isPrefixPath(operation.from, operation.to) ||
        isPrefixPath(operation.to, operation.from)
      ) {
        throw new ChangeSetError("CHAIN_AMBIGUOUS", "move source/destination overlap");
      }
      if (
        !caseOnlyRename(operation.from, operation.to, caseSensitive) &&
        namesAlias(operation.from, operation.to, caseSensitive)
      ) {
        throw new ChangeSetError("ALIAS_AMBIGUOUS", "move aliases the same logical path");
      }
    }
    for (const path of operationPaths(operation)) {
      const list = kindsByPath.get(path) ?? [];
      list.push(operation.kind);
      kindsByPath.set(path, list);
    }
  }
  for (const [path, kinds] of kindsByPath) {
    if (!isCanonicalKindChain(kinds)) {
      throw new ChangeSetError(
        "CHAIN_AMBIGUOUS",
        `non-canonical operation chain on ${path}: ${kinds.join(" -> ")}`,
      );
    }
  }
}

function namesAlias(left: string, right: string, caseSensitive: boolean): boolean {
  if (left === right) {
    return true;
  }
  if (caseSensitive) {
    return left.normalize("NFC") === right.normalize("NFC") && left !== right;
  }
  return caseFoldKey(left, false) === caseFoldKey(right, false);
}

export function declaredPaths(operations: readonly ChangeOperation[]): Set<string> {
  const paths = new Set<string>();
  for (const operation of operations) {
    for (const path of operationPaths(operation)) {
      paths.add(path);
    }
  }
  return paths;
}
