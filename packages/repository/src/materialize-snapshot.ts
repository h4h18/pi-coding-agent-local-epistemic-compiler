import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Compile } from "typebox/compile";
import {
  canonicalizeRfc8785,
  GitHistoryManifestSchema,
  objectDigestFromBytes,
  SnapshotEntrySchema,
  SnapshotManifestSchema,
  taggedHash,
  toJsonValue,
  type JsonValue,
  type ObjectDigest,
  type SnapshotEntry,
  type SnapshotManifest,
} from "@pi-hec/contracts";
import type { BlobStore } from "@pi-hec/cas";

const MANIFEST = Compile(SnapshotManifestSchema);
const ENTRY = Compile(SnapshotEntrySchema);
const HISTORY = Compile(GitHistoryManifestSchema);
const CHUNK_BYTES = 4 * 1024 * 1024;

export class MaterializeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MaterializeError";
    this.code = code;
  }
}

export function assertGitHistoryManifest(value: unknown): void {
  if (!HISTORY.Check(value)) {
    throw new MaterializeError("SCHEMA_INVALID", "GitHistoryManifest schema invalid");
  }
}

export function assertSnapshotEntry(value: unknown): void {
  if (!ENTRY.Check(value)) {
    throw new MaterializeError("SCHEMA_INVALID", "SnapshotEntry schema invalid");
  }
}

export type MaterializeSnapshotInput = {
  destRoot: string;
  projectId: string;
  manifest: SnapshotManifest;
  blobs: BlobStore;
};

export type MaterializeSnapshotResult = {
  rootDigest: SnapshotManifest["rootDigest"];
  writtenPaths: string[];
};

export async function materializeSnapshot(
  input: MaterializeSnapshotInput,
): Promise<MaterializeSnapshotResult> {
  if (!MANIFEST.Check(input.manifest)) {
    throw new MaterializeError("SCHEMA_INVALID", "SnapshotManifest schema invalid");
  }
  const destRoot = path.resolve(input.destRoot);
  await mkdir(destRoot, { recursive: true });
  const written: string[] = [];
  const sorted = [...input.manifest.entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  for (const entry of sorted) {
    const dest = resolveInside(destRoot, entry.path);
    switch (entry.entryType) {
      case "directory":
        await mkdir(dest, { recursive: true });
        written.push(entry.path);
        break;
      case "file": {
        const bytes = await loadFileBytes(input, entry);
        if (digestOf(bytes) !== entry.contentDigest) {
          throw new MaterializeError("CONTENT_DIGEST_MISMATCH", `file ${entry.path} digest mismatch`);
        }
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, bytes);
        written.push(entry.path);
        break;
      }
      case "symlink": {
        const target = normalizeSymlinkTarget(entry.symlinkTarget);
        const resolved = path.resolve(path.dirname(dest), target);
        if (!isInside(destRoot, resolved)) {
          throw new MaterializeError("SYMLINK_ESCAPE", `symlink ${entry.path} escapes sandbox`);
        }
        await mkdir(path.dirname(dest), { recursive: true });
        await symlink(target, dest);
        written.push(entry.path);
        break;
      }
      case "submodule":
        await mkdir(dest, { recursive: true });
        written.push(entry.path);
        break;
      default: {
        const exhaustive: never = entry;
        throw new MaterializeError("SCHEMA_INVALID", `unhandled entry ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  const rootDigest = snapshotRootDigest(input.manifest);
  if (rootDigest !== input.manifest.rootDigest) {
    throw new MaterializeError("ROOT_DIGEST_MISMATCH", "materialized rootDigest mismatch");
  }
  return { rootDigest, writtenPaths: written };
}

export function snapshotRootDigest(manifest: SnapshotManifest): SnapshotManifest["rootDigest"] {
  const payload: { [key: string]: JsonValue } = {
    repositoryId: manifest.repositoryId,
    workspaceId: manifest.workspaceId,
    dirty: manifest.dirty,
    filesystem: {
      rootChildNameComparison: manifest.filesystem.rootChildNameComparison,
      unicodeNormalization: manifest.filesystem.unicodeNormalization,
      unicodeSimpleFoldTableObjectDigest: manifest.filesystem.unicodeSimpleFoldTableObjectDigest,
      pathGlobDialect: manifest.filesystem.pathGlobDialect,
      volumeIdentity: manifest.filesystem.volumeIdentity,
    },
    entries: toJsonValue(manifest.entries),
    ignoredPathDigests: [...manifest.ignoredPathDigests],
    excludedPaths: toJsonValue(manifest.excludedPaths),
  };
  if (manifest.gitHead !== undefined) {
    payload.gitHead = manifest.gitHead;
  }
  if (manifest.gitIndexDigest !== undefined) {
    payload.gitIndexDigest = manifest.gitIndexDigest;
  }
  if (manifest.gitHistoryRootDigest !== undefined) {
    payload.gitHistoryRootDigest = manifest.gitHistoryRootDigest;
  }
  return taggedHash("snapshot-root", 1, payload);
}

export function unicodeSimpleFoldTableDigest(): ObjectDigest {
  const canonical = canonicalizeRfc8785({
    algorithm: "Unicode Simple_Case_Folding",
    pathGlobDialect: "pi-hec-pathglob/v1",
    unicodeVersion: "16.0.0",
  });
  return objectDigestFromBytes(Buffer.from(canonical, "utf8"));
}

async function loadFileBytes(
  input: MaterializeSnapshotInput,
  entry: Extract<SnapshotEntry, { entryType: "file" }>,
): Promise<Uint8Array> {
  if (entry.storage.kind === "blob") {
        const bytes = await input.blobs.getObject({
      projectId: input.projectId,
      objectDigest: entry.storage.objectDigest as ObjectDigest,
    });
    if (bytes.byteLength !== entry.size) {
      throw new MaterializeError("SIZE_MISMATCH", `file ${entry.path} size mismatch`);
    }
    return bytes;
  }
  const chunks = [...entry.storage.chunks].sort((left, right) => left.offset - right.offset);
  if (chunks[0]?.offset !== 0) {
    throw new MaterializeError("CHUNK_GAP", `file ${entry.path} chunks must start at 0`);
  }
  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.offset !== cursor) {
      throw new MaterializeError("CHUNK_GAP", `file ${entry.path} chunk gap or overlap`);
    }
    if (chunk.length <= 0 || chunk.length > CHUNK_BYTES) {
      throw new MaterializeError("CHUNK_LENGTH", `file ${entry.path} invalid chunk length`);
    }
    const bytes = await input.blobs.getObject({
      projectId: input.projectId,
      objectDigest: chunk.digest as ObjectDigest,
    });
    if (bytes.byteLength !== chunk.length) {
      throw new MaterializeError("CHUNK_LENGTH", `file ${entry.path} chunk object length mismatch`);
    }
    if (digestOf(bytes) !== chunk.digest) {
      throw new MaterializeError("CHUNK_DIGEST", `file ${entry.path} chunk digest mismatch`);
    }
    parts.push(bytes);
    cursor += chunk.length;
  }
  if (cursor !== entry.size) {
    throw new MaterializeError("SIZE_MISMATCH", `file ${entry.path} reconstructed size mismatch`);
  }
  const out = new Uint8Array(cursor);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function resolveInside(root: string, relative: string): string {
  if (relative.includes("\\") || relative.startsWith("/") || relative.split("/").includes("..")) {
    throw new MaterializeError("PATH_ESCAPE", `illegal snapshot path ${relative}`);
  }
  const dest = path.resolve(root, ...relative.split("/"));
  if (!isInside(root, dest)) {
    throw new MaterializeError("PATH_ESCAPE", `path ${relative} escapes sandbox`);
  }
  return dest;
}

function normalizeSymlinkTarget(target: string): string {
  if (
    target.includes("\0") ||
    path.isAbsolute(target) ||
    target.startsWith("\\\\") ||
    target.startsWith("/")
  ) {
    throw new MaterializeError("SYMLINK_ESCAPE", "absolute or UNC symlink target rejected");
  }
  return target.replaceAll("\\", "/");
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function digestOf(bytes: Uint8Array | Buffer): ObjectDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ObjectDigest;
}
