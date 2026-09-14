import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertWorkspaceConcealed, posixFrom, walkWorkspaceFiles } from "./concealment.js";
import { GOLDEN_REPOS } from "./repos.js";
import { git, initGitRepo, snapshotTree, writeTree } from "./tree.js";
import type { GoldenRepoId, MaterializedRepo } from "./types.js";
import { GOLDEN_REPO_IDS } from "./types.js";

export const GOLDEN_PROJECT_FOLDER_PREFIX = "golden-";

export type SyncedGoldenProject = MaterializedRepo & {
  readonly independentGit: true;
};

export function hooksRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function goldenProjectsParent(): string {
  return path.resolve(hooksRepoRoot(), "..");
}

export function goldenProjectFolderName(repoId: GoldenRepoId): string {
  return `${GOLDEN_PROJECT_FOLDER_PREFIX}${repoId}`;
}

export function goldenProjectRoot(repoId: GoldenRepoId): string {
  return path.join(goldenProjectsParent(), goldenProjectFolderName(repoId));
}

export function nestedObservedCwd(root: string, repoId: GoldenRepoId): string {
  const repo = GOLDEN_REPOS[repoId];
  const sessionDir = path.join(root, ...repo.paths.session.split("/").slice(0, -1));
  if (existsSync(sessionDir)) {
    return sessionDir;
  }
  return root;
}

function committedPaths(repoId: GoldenRepoId): Set<string> {
  return new Set(Object.keys(GOLDEN_REPOS[repoId].files));
}

function removeEmptyDirectories(dir: string): void {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return;
  }
  for (const entry of readdirSync(dir)) {
    if (entry === ".git") {
      continue;
    }
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      removeEmptyDirectories(full);
      if (readdirSync(full).length === 0) {
        rmSync(full, { recursive: true, force: true });
      }
    }
  }
}

function pruneUnmanagedFiles(root: string, keep: ReadonlySet<string>): void {
  if (!existsSync(root)) {
    return;
  }
  for (const filePath of walkWorkspaceFiles(root)) {
    const relative = posixFrom(root, filePath);
    if (!keep.has(relative)) {
      rmSync(filePath, { force: true });
    }
  }
  removeEmptyDirectories(root);
}

function requireGit(result: { readonly ok: boolean; readonly stderr: string }, action: string): void {
  if (!result.ok) {
    throw new Error(`${action} failed: ${result.stderr}`);
  }
}

function ensureGitBaseline(root: string): string {
  const gitDir = path.join(root, ".git");
  if (!existsSync(gitDir)) {
    return initGitRepo(root);
  }
  requireGit(git(["config", "core.autocrlf", "false"], root), "git config core.autocrlf");
  requireGit(git(["config", "user.name", "pi-hec"], root), "git user.name");
  requireGit(git(["config", "user.email", "hec@pi-hec.local"], root), "git user.email");
  requireGit(git(["add", "-A"], root), "git add");
  const status = git(["status", "--porcelain"], root);
  requireGit(status, "git status");
  if (status.stdout.trim().length > 0) {
    requireGit(
      git(["commit", "-m", "golden baseline", "--author", "pi-hec <hec@pi-hec.local>"], root),
      "git commit",
    );
  }
  const head = git(["rev-parse", "HEAD"], root);
  requireGit(head, "git rev-parse");
  return head.stdout.trim();
}

export function syncGoldenProject(repoId: GoldenRepoId): SyncedGoldenProject {
  const repo = GOLDEN_REPOS[repoId];
  const root = goldenProjectRoot(repoId);
  mkdirSync(root, { recursive: true });
  pruneUnmanagedFiles(root, committedPaths(repoId));
  writeTree(root, repo.files);
  const head = ensureGitBaseline(root);
  if (repo.dirtyAfterCommit !== undefined) {
    writeTree(root, repo.dirtyAfterCommit);
  }
  assertWorkspaceConcealed(root);
  return {
    repoId,
    root,
    head,
    baseline: snapshotTree(root),
    paths: repo.paths,
    independentGit: true,
  };
}

export function syncGoldenProjects(): readonly SyncedGoldenProject[] {
  return GOLDEN_REPO_IDS.map(syncGoldenProject);
}

export function loadSyncedGoldenProject(repoId: GoldenRepoId): SyncedGoldenProject {
  const root = goldenProjectRoot(repoId);
  const gitDir = path.join(root, ".git");
  if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) {
    throw new Error(`golden project ${repoId} is missing an independent git directory at ${root}`);
  }
  const head = git(["rev-parse", "HEAD"], root);
  requireGit(head, "git rev-parse");
  const repo = GOLDEN_REPOS[repoId];
  return {
    repoId,
    root,
    head: head.stdout.trim(),
    baseline: snapshotTree(root),
    paths: repo.paths,
    independentGit: true,
  };
}
