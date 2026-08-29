import { Buffer } from "node:buffer";
import type { ChangeOperation } from "@pi-hec/contracts";
import { ChangeSetError } from "./errors.js";
import { caseOnlyRename, assertSafePath, assertSymlinkTargetContained } from "./paths.js";
import { applyUnifiedDiff } from "./text-patch.js";
import {
  fileDigest,
  symlinkDigest,
  type DirectoryNode,
  type EphemeralTree,
  type FileNode,
  type SymlinkNode,
  type TreeNode,
} from "./tree.js";

const CASE_TEMP_PREFIX = ".pi-hec-case-tmp-";

function decodeBase64(content: string): Uint8Array {
  const bytes = Buffer.from(content, "base64");
  if (bytes.toString("base64") !== content) {
    throw new ChangeSetError("SCHEMA_INVALID", "base64Content is not canonical");
  }
  return new Uint8Array(bytes);
}

function requireExisting(tree: EphemeralTree, path: string): TreeNode {
  const node = tree.get(path);
  if (node === undefined) {
    throw new ChangeSetError("PATH_MUST_EXIST", `${path} does not exist`);
  }
  return node;
}

function requireDigest(node: TreeNode, expected: string, path: string, code: string): void {
  if (node.entryType !== "file" && node.entryType !== "symlink") {
    throw new ChangeSetError(code, `${path} is not a file or symlink`);
  }
  if (digestOf(node) !== expected) {
    throw new ChangeSetError(code, `${path} digest mismatch`);
  }
}

function digestOf(node: FileNode | SymlinkNode): string {
  return node.contentDigest;
}

function metadataOf(node: TreeNode): FileNode["platformMetadata"] | undefined {
  return node.platformMetadata;
}

function uniqueTempPath(tree: EphemeralTree, from: string): string {
  for (let n = 0; n < 64; n += 1) {
    const candidate = `${CASE_TEMP_PREFIX}${String(n)}-${from.replaceAll("/", "_")}`;
    if (!tree.has(candidate)) {
      return candidate;
    }
  }
  throw new ChangeSetError("ALIAS_AMBIGUOUS", "unable to allocate case-rename temporary name");
}

function putFile(
  tree: EphemeralTree,
  path: string,
  gitMode: "100644" | "100755",
  bytes: Uint8Array,
  expectedAfter: string,
  metadata: FileNode["platformMetadata"] | undefined,
): void {
  const contentDigest = fileDigest(bytes);
  if (contentDigest !== expectedAfter) {
    throw new ChangeSetError("DIGEST_AFTER_MISMATCH", `${path} after digest mismatch`);
  }
  const node: FileNode = {
    entryType: "file",
    path,
    gitMode,
    bytes,
    contentDigest,
    ...(metadata === undefined ? {} : { platformMetadata: metadata }),
  };
  tree.set(node);
}

export function applyOperation(tree: EphemeralTree, operation: ChangeOperation): void {
  switch (operation.kind) {
    case "text_patch": {
      assertSafePath(operation.path, operation.path);
      tree.rejectSymlinkAlias(operation.path);
      const node = requireExisting(tree, operation.path);
      if (node.entryType !== "file") {
        throw new ChangeSetError("TEXT_PATCH_ENCODING", `${operation.path} is not a text file`);
      }
      requireDigest(node, operation.expectedBeforeDigest, operation.path, "DIGEST_BEFORE_MISMATCH");
      const next = applyUnifiedDiff(node.bytes, {
        unifiedDiff: operation.unifiedDiff,
        path: operation.path,
        insertedLineEnding: operation.insertedLineEnding,
        finalNewline: operation.finalNewline,
      });
      putFile(tree, operation.path, node.gitMode, next, operation.expectedAfterDigest, metadataOf(node));
      return;
    }
    case "create_text": {
      assertSafePath(operation.path, operation.path);
      tree.requireAbsent(operation.path);
      tree.requireParentDirectory(operation.path);
      tree.rejectSymlinkAlias(operation.path);
      const bytes = Buffer.from(operation.content, "utf8");
      if (bytes.includes(0)) {
        throw new ChangeSetError("TEXT_PATCH_ENCODING", `${operation.path} text contains NUL`);
      }
      putFile(tree, operation.path, operation.gitMode, new Uint8Array(bytes), operation.expectedAfterDigest, undefined);
      return;
    }
    case "create_directory": {
      assertSafePath(operation.path, operation.path);
      tree.requireAbsent(operation.path);
      tree.requireParentDirectory(operation.path);
      tree.rejectSymlinkAlias(operation.path);
      const node: DirectoryNode = { entryType: "directory", path: operation.path };
      tree.set(node);
      return;
    }
    case "write_binary": {
      assertSafePath(operation.path, operation.path);
      tree.requireParentDirectory(operation.path);
      tree.rejectSymlinkAlias(operation.path);
      const bytes = decodeBase64(operation.base64Content);
      const existing = tree.get(operation.path);
      if (operation.expectedBeforeDigest === null) {
        tree.requireAbsent(operation.path);
        putFile(tree, operation.path, operation.gitMode, bytes, operation.expectedAfterDigest, undefined);
        return;
      }
      if (existing === undefined) {
        throw new ChangeSetError("PATH_MUST_EXIST", `${operation.path} does not exist`);
      }
      if (existing.entryType !== "file" && existing.entryType !== "symlink") {
        throw new ChangeSetError("DIGEST_BEFORE_MISMATCH", `${operation.path} cannot be replaced`);
      }
      requireDigest(existing, operation.expectedBeforeDigest, operation.path, "DIGEST_BEFORE_MISMATCH");
      putFile(tree, operation.path, operation.gitMode, bytes, operation.expectedAfterDigest, metadataOf(existing));
      return;
    }
    case "delete": {
      assertSafePath(operation.path, operation.path);
      tree.rejectSymlinkAlias(operation.path);
      const node = requireExisting(tree, operation.path);
      if (node.entryType !== "file" && node.entryType !== "symlink") {
        throw new ChangeSetError("PATH_MUST_EXIST", `${operation.path} is not a file or symlink`);
      }
      requireDigest(node, operation.expectedBeforeDigest, operation.path, "DIGEST_BEFORE_MISMATCH");
      tree.delete(operation.path);
      return;
    }
    case "delete_directory": {
      assertSafePath(operation.path, operation.path);
      tree.rejectSymlinkAlias(operation.path);
      const node = requireExisting(tree, operation.path);
      if (node.entryType !== "directory") {
        throw new ChangeSetError("DIRECTORY_NOT_EMPTY", `${operation.path} is not a directory`);
      }
      const children = tree.children(operation.path);
      if (children.length > 0) {
        throw new ChangeSetError("DIRECTORY_NOT_EMPTY", `${operation.path} is not empty`);
      }
      const digest = tree.directoryTreeDigest(operation.path);
      if (digest !== operation.expectedTreeDigest) {
        throw new ChangeSetError("DIRECTORY_TREE_MISMATCH", `${operation.path} directory-tree digest mismatch`);
      }
      tree.delete(operation.path);
      return;
    }
    case "move": {
      assertSafePath(operation.from, operation.from);
      assertSafePath(operation.to, operation.to);
      tree.rejectSymlinkAlias(operation.from);
      tree.rejectSymlinkAlias(operation.to);
      const source = requireExisting(tree, operation.from);
      if (source.entryType !== "file" && source.entryType !== "symlink") {
        throw new ChangeSetError("MOVE_DIRECTORY_FORBIDDEN", "revision 1 move supports file/symlink only");
      }
      requireDigest(source, operation.expectedBeforeDigest, operation.from, "DIGEST_BEFORE_MISMATCH");
      tree.requireParentDirectory(operation.to);
      const caseRename = caseOnlyRename(operation.from, operation.to, tree.caseSensitive);
      const destination = tree.get(operation.to);
      if (operation.expectedDestinationDigest === null) {
        if (destination !== undefined && !caseRename) {
          throw new ChangeSetError("MOVE_OVERWRITE", `${operation.to} exists and overwrite is unstated`);
        }
      } else {
        if (destination === undefined) {
          throw new ChangeSetError("PATH_MUST_EXIST", `${operation.to} does not exist`);
        }
        if (destination.entryType !== "file" && destination.entryType !== "symlink") {
          throw new ChangeSetError("MOVE_OVERWRITE", `${operation.to} is not replaceable`);
        }
        requireDigest(destination, operation.expectedDestinationDigest, operation.to, "DIGEST_BEFORE_MISMATCH");
      }
      if (caseRename) {
        const temp = uniqueTempPath(tree, operation.from);
        tree.delete(operation.from);
        const relocated: TreeNode =
          source.entryType === "file"
            ? { ...source, path: temp }
            : { ...source, path: temp };
        tree.set(relocated);
        tree.delete(temp);
        const finalNode: TreeNode =
          source.entryType === "file" ? { ...source, path: operation.to } : { ...source, path: operation.to };
        tree.set(finalNode);
        return;
      }
      if (destination !== undefined) {
        tree.delete(operation.to);
      }
      tree.delete(operation.from);
      const moved: TreeNode =
        source.entryType === "file" ? { ...source, path: operation.to } : { ...source, path: operation.to };
      tree.set(moved);
      return;
    }
    case "set_git_mode": {
      assertSafePath(operation.path, operation.path);
      tree.rejectSymlinkAlias(operation.path);
      const node = requireExisting(tree, operation.path);
      if (node.entryType !== "file") {
        throw new ChangeSetError("MODE_INVALID", `${operation.path} is not a regular file`);
      }
      requireDigest(node, operation.expectedBeforeDigest, operation.path, "DIGEST_BEFORE_MISMATCH");
      if (node.gitMode !== operation.expectedCurrentMode) {
        throw new ChangeSetError("MODE_INVALID", `${operation.path} current mode mismatch`);
      }
      if (operation.expectedCurrentMode === operation.newMode) {
        throw new ChangeSetError("MODE_INVALID", `${operation.path} mode does not change`);
      }
      tree.set({ ...node, gitMode: operation.newMode });
      return;
    }
    case "symlink": {
      assertSafePath(operation.path, operation.path);
      tree.requireParentDirectory(operation.path);
      tree.rejectSymlinkAlias(operation.path);
      const normalized = assertSymlinkTargetContained(operation.path, operation.target);
      const after = symlinkDigest(normalized);
      if (after !== operation.expectedAfterDigest) {
        throw new ChangeSetError("DIGEST_AFTER_MISMATCH", `${operation.path} after digest mismatch`);
      }
      const existing = tree.get(operation.path);
      const keptMeta = existing === undefined ? undefined : metadataOf(existing);
      if (operation.expectedBeforeDigest === null) {
        tree.requireAbsent(operation.path);
      } else {
        if (existing === undefined) {
          throw new ChangeSetError("PATH_MUST_EXIST", `${operation.path} does not exist`);
        }
        if (existing.entryType !== "file" && existing.entryType !== "symlink") {
          throw new ChangeSetError("DIGEST_BEFORE_MISMATCH", `${operation.path} cannot become a symlink`);
        }
        requireDigest(existing, operation.expectedBeforeDigest, operation.path, "DIGEST_BEFORE_MISMATCH");
        tree.delete(operation.path);
      }
      const node: SymlinkNode = {
        entryType: "symlink",
        path: operation.path,
        symlinkTarget: normalized,
        contentDigest: after,
        ...(keptMeta === undefined ? {} : { platformMetadata: keptMeta }),
      };
      tree.set(node);
      return;
    }
    default: {
      const exhaustive: never = operation;
      throw new ChangeSetError("UNHANDLED_OPERATION", `unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}
