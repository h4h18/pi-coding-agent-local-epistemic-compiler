import { createHash } from "node:crypto";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  sha256Hex,
  taggedHash,
  type Digest,
  type DomainDigest,
  type JsonValue,
} from "@pi-hec/contracts";
import { caseFoldKey, classifyRelativePath } from "./relative-path.js";

export class CandidateMaterializeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CandidateMaterializeError";
    this.code = code;
  }
}

export type CandidateFileEntry = {
  entryType: "file";
  path: string;
  gitMode: "100644" | "100755";
  bytes: Uint8Array;
  contentDigest: Digest;
};

export type CandidateDirectoryEntry = {
  entryType: "directory";
  path: string;
};

export type CandidateSymlinkEntry = {
  entryType: "symlink";
  path: string;
  symlinkTarget: string;
  contentDigest: Digest;
};

export type CandidateSubmoduleEntry = {
  entryType: "submodule";
  path: string;
  gitObjectId: string;
};

export type CandidateEntry =
  CandidateFileEntry | CandidateDirectoryEntry | CandidateSymlinkEntry | CandidateSubmoduleEntry;

export type MaterializeCandidateTreeInput = {
  destRoot: string;
  entries: readonly CandidateEntry[];
};

export type MaterializeCandidateTreeResult = {
  materializedTreeDigest: DomainDigest<"candidate-tree">;
  writtenPaths: string[];
};

function compareUtf8(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveInside(root: string, relative: string): string {
  const classified = classifyRelativePath(relative);
  if (classified !== undefined) {
    throw new CandidateMaterializeError(classified, `illegal candidate path ${relative}`);
  }
  const dest = path.resolve(root, ...relative.split("/"));
  if (!isInside(root, dest)) {
    throw new CandidateMaterializeError("PATH_ESCAPE", `path ${relative} escapes sandbox`);
  }
  assertResolvedNotProtected(root, dest, relative);
  return dest;
}

function assertResolvedNotProtected(root: string, dest: string, relative: string): void {
  const rel = path.relative(root, dest);
  if (rel === "") {
    throw new CandidateMaterializeError("PATH_ESCAPE", `path ${relative} escapes sandbox`);
  }
  for (const segment of rel.split(/[/\\]/)) {
    if (segment.length === 0) {
      continue;
    }
    if (caseFoldKey(segment, false) === ".GIT") {
      throw new CandidateMaterializeError(
        "PATH_PROTECTED",
        `path ${relative} touches protected .git`,
      );
    }
  }
}

function projectEntry(entry: CandidateEntry): { [key: string]: JsonValue } {
  switch (entry.entryType) {
    case "file":
      return {
        path: entry.path,
        entryType: "file",
        contentDigest: entry.contentDigest,
        size: entry.bytes.byteLength,
        gitMode: entry.gitMode,
      };
    case "directory":
      return { path: entry.path, entryType: "directory" };
    case "symlink":
      return {
        path: entry.path,
        entryType: "symlink",
        symlinkTarget: entry.symlinkTarget,
        contentDigest: entry.contentDigest,
        gitMode: "120000",
      };
    case "submodule":
      return {
        path: entry.path,
        entryType: "submodule",
        gitObjectId: entry.gitObjectId,
        gitMode: "160000",
      };
    default: {
      const exhaustive: never = entry;
      throw new CandidateMaterializeError(
        "SCHEMA_INVALID",
        `unhandled union: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

export function candidateTreeDigest(
  entries: readonly CandidateEntry[],
): DomainDigest<"candidate-tree"> {
  const projected = entries.map(projectEntry).sort((left, right) => {
    const leftPath = typeof left.path === "string" ? left.path : "";
    const rightPath = typeof right.path === "string" ? right.path : "";
    return compareUtf8(leftPath, rightPath);
  });
  return taggedHash("candidate-tree", 1, { entries: projected });
}

function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertEntryDigest(entry: CandidateEntry): void {
  switch (entry.entryType) {
    case "file":
      if (
        sha256Hex(entry.bytes) !== entry.contentDigest ||
        digestOf(entry.bytes) !== entry.contentDigest
      ) {
        throw new CandidateMaterializeError(
          "CONTENT_DIGEST_MISMATCH",
          `file ${entry.path} digest mismatch`,
        );
      }
      return;
    case "symlink":
      if (sha256Hex(Buffer.from(entry.symlinkTarget, "utf8")) !== entry.contentDigest) {
        throw new CandidateMaterializeError(
          "CONTENT_DIGEST_MISMATCH",
          `symlink ${entry.path} digest mismatch`,
        );
      }
      return;
    case "directory":
    case "submodule":
      return;
    default: {
      const exhaustive: never = entry;
      throw new CandidateMaterializeError(
        "SCHEMA_INVALID",
        `unhandled union: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

export async function materializeCandidateTree(
  input: MaterializeCandidateTreeInput,
): Promise<MaterializeCandidateTreeResult> {
  const destRoot = path.resolve(input.destRoot);
  await mkdir(destRoot, { recursive: true });
  const existing = await readdir(destRoot);
  if (existing.length > 0) {
    throw new CandidateMaterializeError("DEST_NOT_EMPTY", "candidate destRoot must be empty");
  }
  const sorted = [...input.entries].sort((left, right) => {
    const rank = (entry: CandidateEntry): number => {
      switch (entry.entryType) {
        case "directory":
          return 0;
        case "file":
          return 1;
        case "symlink":
          return 2;
        case "submodule":
          return 3;
        default: {
          const exhaustive: never = entry;
          throw new CandidateMaterializeError(
            "SCHEMA_INVALID",
            `unhandled union: ${JSON.stringify(exhaustive)}`,
          );
        }
      }
    };
    const byType = rank(left) - rank(right);
    if (byType !== 0) {
      return byType;
    }
    return compareUtf8(left.path, right.path);
  });
  const written: string[] = [];
  for (const entry of sorted) {
    assertEntryDigest(entry);
    const dest = resolveInside(destRoot, entry.path);
    switch (entry.entryType) {
      case "directory":
        await mkdir(dest, { recursive: false });
        written.push(entry.path);
        break;
      case "file":
        await writeFile(dest, entry.bytes);
        written.push(entry.path);
        break;
      case "symlink": {
        const resolved = path.resolve(path.dirname(dest), entry.symlinkTarget);
        if (!isInside(destRoot, resolved)) {
          throw new CandidateMaterializeError(
            "SYMLINK_ESCAPE",
            `symlink ${entry.path} escapes sandbox`,
          );
        }
        assertResolvedNotProtected(destRoot, resolved, entry.path);
        await symlink(entry.symlinkTarget, dest);
        written.push(entry.path);
        break;
      }
      case "submodule":
        await mkdir(dest, { recursive: false });
        written.push(entry.path);
        break;
      default: {
        const exhaustive: never = entry;
        throw new CandidateMaterializeError(
          "SCHEMA_INVALID",
          `unhandled union: ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }
  return {
    materializedTreeDigest: candidateTreeDigest(input.entries),
    writtenPaths: written,
  };
}
