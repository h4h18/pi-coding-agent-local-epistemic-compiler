import { rmSync } from "node:fs";
import { posixFrom, walkWorkspaceFiles } from "./concealment.js";
import { GOLDEN_REPOS } from "./repos.js";
import { writeTree } from "./tree.js";
import type { MaterializedRepo } from "./types.js";

export function applyEdits(root: string, edits: Readonly<Record<string, string>>): void {
  writeTree(root, edits);
}

export function restoreGoldenWorkspace(materialized: MaterializedRepo): void {
  const repo = GOLDEN_REPOS[materialized.repoId];
  const allowed = new Set(Object.keys(repo.files));
  if (repo.dirtyAfterCommit !== undefined) {
    for (const filePath of Object.keys(repo.dirtyAfterCommit)) {
      allowed.add(filePath);
    }
  }
  for (const filePath of walkWorkspaceFiles(materialized.root)) {
    const relative = posixFrom(materialized.root, filePath);
    if (!allowed.has(relative)) {
      rmSync(filePath, { force: true });
    }
  }
  writeTree(materialized.root, repo.files);
  if (repo.dirtyAfterCommit !== undefined) {
    writeTree(materialized.root, repo.dirtyAfterCommit);
  }
}
