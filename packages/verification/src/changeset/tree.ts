import {
  sha256Hex,
  sha256Utf8,
  taggedHash,
  type Digest,
  type DomainDigest,
  type JsonValue,
  type SnapshotEntry,
} from "@pi-hec/contracts";
import type { CandidateEntry } from "@pi-hec/repository";
import { ChangeSetError } from "./errors.js";
import {
  assertSafePath,
  assertSymlinkTargetContained,
  basename,
  namesCollide,
  parentPath,
  simpleFold,
} from "./paths.js";

export type BaselineFilesystem = {
  platform: "windows" | "linux" | "macos";
  rootChildNameComparison: "case-sensitive" | "case-insensitive";
  unicodeNormalization: "NFC" | "NFD" | "none";
};

export type BaselineEntry = CandidateEntry & {
  platformMetadata?: SnapshotEntry["platformMetadata"];
};

export type FileNode = {
  entryType: "file";
  path: string;
  gitMode: "100644" | "100755";
  bytes: Uint8Array;
  contentDigest: Digest;
  platformMetadata?: SnapshotEntry["platformMetadata"];
};

export type DirectoryNode = {
  entryType: "directory";
  path: string;
  platformMetadata?: SnapshotEntry["platformMetadata"];
};

export type SymlinkNode = {
  entryType: "symlink";
  path: string;
  symlinkTarget: string;
  contentDigest: Digest;
  platformMetadata?: SnapshotEntry["platformMetadata"];
};

export type SubmoduleNode = {
  entryType: "submodule";
  path: string;
  gitObjectId: string;
  platformMetadata?: SnapshotEntry["platformMetadata"];
};

export type TreeNode = FileNode | DirectoryNode | SymlinkNode | SubmoduleNode;

export function fileDigest(bytes: Uint8Array): Digest {
  return sha256Hex(bytes);
}

export function symlinkDigest(target: string): Digest {
  return sha256Utf8(target);
}

export function identityKey(
  metadata: SnapshotEntry["platformMetadata"] | undefined,
): string | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  if (metadata.kind === "windows") {
    return `windows:${metadata.fileId}`;
  }
  return `posix:${metadata.device}:${metadata.inode}`;
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function fromBaseline(entry: BaselineEntry): TreeNode {
  switch (entry.entryType) {
    case "file": {
      const digest = fileDigest(entry.bytes);
      if (digest !== entry.contentDigest) {
        throw new ChangeSetError("BASELINE_DIGEST", `baseline file ${entry.path} digest mismatch`);
      }
      return {
        entryType: "file",
        path: entry.path,
        gitMode: entry.gitMode,
        bytes: cloneBytes(entry.bytes),
        contentDigest: digest,
        ...(entry.platformMetadata === undefined
          ? {}
          : { platformMetadata: entry.platformMetadata }),
      };
    }
    case "directory":
      return {
        entryType: "directory",
        path: entry.path,
        ...(entry.platformMetadata === undefined
          ? {}
          : { platformMetadata: entry.platformMetadata }),
      };
    case "symlink": {
      const digest = symlinkDigest(entry.symlinkTarget);
      if (digest !== entry.contentDigest) {
        throw new ChangeSetError(
          "BASELINE_DIGEST",
          `baseline symlink ${entry.path} digest mismatch`,
        );
      }
      return {
        entryType: "symlink",
        path: entry.path,
        symlinkTarget: entry.symlinkTarget,
        contentDigest: digest,
        ...(entry.platformMetadata === undefined
          ? {}
          : { platformMetadata: entry.platformMetadata }),
      };
    }
    case "submodule":
      return {
        entryType: "submodule",
        path: entry.path,
        gitObjectId: entry.gitObjectId,
        ...(entry.platformMetadata === undefined
          ? {}
          : { platformMetadata: entry.platformMetadata }),
      };
    default: {
      const exhaustive: never = entry;
      throw new ChangeSetError(
        "UNHANDLED_OPERATION",
        `unhandled union: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

export class EphemeralTree {
  private readonly nodes = new Map<string, TreeNode>();
  readonly caseSensitive: boolean;

  constructor(
    readonly filesystem: BaselineFilesystem,
    entries: readonly BaselineEntry[],
  ) {
    this.caseSensitive = filesystem.rootChildNameComparison === "case-sensitive";
    for (const entry of entries) {
      assertSafePath(entry.path, `baseline ${entry.path}`, { allowProtectedGit: true });
      if (this.nodes.has(entry.path)) {
        throw new ChangeSetError("ALIAS_AMBIGUOUS", `duplicate baseline path ${entry.path}`);
      }
      this.nodes.set(entry.path, fromBaseline(entry));
    }
    this.assertInvariants();
  }

  get(path: string): TreeNode | undefined {
    return this.nodes.get(path);
  }

  has(path: string): boolean {
    return this.nodes.has(path);
  }

  requireAbsent(path: string): void {
    if (this.nodes.has(path)) {
      throw new ChangeSetError("PATH_MUST_BE_ABSENT", `${path} must be absent`);
    }
    this.rejectAlias(path);
  }

  requireParentDirectory(path: string): void {
    const parent = parentPath(path);
    if (parent === undefined) {
      return;
    }
    const node = this.nodes.get(parent);
    if (node === undefined || node.entryType !== "directory") {
      throw new ChangeSetError("PARENT_MISSING", `parent directory missing for ${path}`);
    }
  }

  rejectSymlinkAlias(path: string): void {
    const segments = path.split("/");
    let prefix = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      prefix = prefix.length === 0 ? (segments[index] ?? "") : `${prefix}/${segments[index] ?? ""}`;
      const node = this.nodes.get(prefix);
      if (node?.entryType === "symlink") {
        throw new ChangeSetError("SYMLINK_ALIAS", `${path} aliases through symlink ${prefix}`);
      }
    }
  }

  rejectAlias(path: string): void {
    this.rejectSymlinkAlias(path);
    const parent = parentPath(path);
    const name = basename(path);
    for (const existing of this.nodes.keys()) {
      if (existing === path) {
        continue;
      }
      if (parentPath(existing) !== parent) {
        continue;
      }
      if (namesCollide(name, basename(existing), this.caseSensitive)) {
        throw new ChangeSetError("ALIAS_AMBIGUOUS", `${path} collides with ${existing}`);
      }
    }
  }

  set(node: TreeNode): void {
    this.nodes.set(node.path, node);
  }

  delete(path: string): TreeNode {
    const node = this.nodes.get(path);
    if (node === undefined) {
      throw new ChangeSetError("PATH_MUST_EXIST", `${path} does not exist`);
    }
    this.nodes.delete(path);
    return node;
  }

  children(dirPath: string): TreeNode[] {
    const prefix = `${dirPath}/`;
    const out: TreeNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.path.startsWith(prefix) && parentPath(node.path) === dirPath) {
        out.push(node);
      }
    }
    return out;
  }

  list(): TreeNode[] {
    return [...this.nodes.values()];
  }

  contentDigestOf(node: TreeNode): Digest {
    switch (node.entryType) {
      case "file":
        return node.contentDigest;
      case "symlink":
        return node.contentDigest;
      case "directory":
        return this.directoryTreeDigest(node.path);
      case "submodule":
        return sha256Utf8(node.gitObjectId);
      default: {
        const exhaustive: never = node;
        throw new ChangeSetError(
          "UNHANDLED_OPERATION",
          `unhandled union: ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }

  directoryTreeDigest(path: string): DomainDigest<"directory-tree"> {
    const children = this.children(path)
      .map((child) => ({
        path: child.path,
        entryType: child.entryType,
        digest: this.contentDigestOf(child),
      }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return taggedHash("directory-tree", 1, {
      path,
      entries: children,
    });
  }

  toCandidateEntries(): CandidateEntry[] {
    return this.list()
      .map((node) => this.toCandidate(node))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }

  assertInvariants(): void {
    const identities = new Map<string, string>();
    const foldKeys = new Map<string, string>();
    for (const node of this.nodes.values()) {
      assertSafePath(node.path, node.path, { allowProtectedGit: true });
      this.rejectSymlinkAlias(node.path);
      const parent = parentPath(node.path);
      if (parent !== undefined) {
        const parentNode = this.nodes.get(parent);
        if (parentNode === undefined || parentNode.entryType !== "directory") {
          throw new ChangeSetError("PARENT_MISSING", `parent directory missing for ${node.path}`);
        }
      }
      if (node.entryType === "symlink") {
        assertSymlinkTargetContained(node.path, node.symlinkTarget);
      }
      const key = identityKey(node.platformMetadata);
      if (key !== undefined) {
        const previous = identities.get(key);
        if (previous !== undefined && previous !== node.path) {
          throw new ChangeSetError(
            "HARDLINK",
            `hardlink identity ${key} shared by ${previous} and ${node.path}`,
          );
        }
        identities.set(key, node.path);
      }
      const parentKey = parent ?? "";
      const fold = `${parentKey}\0${this.caseSensitive ? basename(node.path) : simpleFold(basename(node.path))}`;
      const existing = foldKeys.get(fold);
      if (existing !== undefined && existing !== node.path) {
        throw new ChangeSetError("CASE_COLLISION", `${node.path} collides with ${existing}`);
      }
      foldKeys.set(fold, node.path);
      if (
        node.platformMetadata?.kind === "windows" &&
        node.platformMetadata.alternateStreams.length > 0
      ) {
        if (node.entryType !== "file" && node.entryType !== "directory") {
          throw new ChangeSetError("PATH_ADS", `${node.path} has ADS on a non-file entry`);
        }
      }
    }
  }

  private toCandidate(node: TreeNode): CandidateEntry {
    switch (node.entryType) {
      case "file":
        return {
          entryType: "file",
          path: node.path,
          gitMode: node.gitMode,
          bytes: cloneBytes(node.bytes),
          contentDigest: node.contentDigest,
        };
      case "directory":
        return { entryType: "directory", path: node.path };
      case "symlink":
        return {
          entryType: "symlink",
          path: node.path,
          symlinkTarget: node.symlinkTarget,
          contentDigest: node.contentDigest,
        };
      case "submodule":
        return { entryType: "submodule", path: node.path, gitObjectId: node.gitObjectId };
      default: {
        const exhaustive: never = node;
        throw new ChangeSetError(
          "UNHANDLED_OPERATION",
          `unhandled union: ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }
}

export function snapshotFingerprint(node: TreeNode | undefined): JsonValue {
  if (node === undefined) {
    return null;
  }
  switch (node.entryType) {
    case "file":
      return {
        entryType: "file",
        path: node.path,
        gitMode: node.gitMode,
        contentDigest: node.contentDigest,
      };
    case "directory":
      return { entryType: "directory", path: node.path };
    case "symlink":
      return {
        entryType: "symlink",
        path: node.path,
        symlinkTarget: node.symlinkTarget,
        contentDigest: node.contentDigest,
      };
    case "submodule":
      return { entryType: "submodule", path: node.path, gitObjectId: node.gitObjectId };
    default: {
      const exhaustive: never = node;
      throw new ChangeSetError(
        "UNHANDLED_OPERATION",
        `unhandled union: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}
