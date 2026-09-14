import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { posixFrom, walkWorkspaceFiles } from "./concealment.js";
import type { TreeSnapshot } from "./types.js";

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "pi-hec",
  GIT_AUTHOR_EMAIL: "hec@pi-hec.local",
  GIT_COMMITTER_NAME: "pi-hec",
  GIT_COMMITTER_EMAIL: "hec@pi-hec.local",
  GIT_CONFIG_NOSYSTEM: "1",
} as const;

export function git(
  args: readonly string[],
  cwd: string,
): { readonly ok: boolean; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
    env: { ...process.env, ...GIT_IDENTITY },
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content.replaceAll("\r\n", "\n"), "utf8");
  }
}

export function snapshotTree(root: string): TreeSnapshot {
  const snapshot: Record<string, string> = {};
  for (const filePath of walkWorkspaceFiles(root)) {
    const relative = posixFrom(root, filePath);
    snapshot[relative] = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  }
  return snapshot;
}

export function readWorkspaceFile(root: string, relative: string): string | undefined {
  const full = path.join(root, ...relative.split("/"));
  try {
    return readFileSync(full, "utf8");
  } catch {
    return undefined;
  }
}

export type TreeDiff = {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
};

export function diffTrees(before: TreeSnapshot, after: TreeSnapshot): TreeDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [filePath, digest] of Object.entries(after)) {
    const previous = before[filePath];
    if (previous === undefined) {
      added.push(filePath);
      continue;
    }
    if (previous !== digest) {
      changed.push(filePath);
    }
  }
  for (const filePath of Object.keys(before)) {
    if (after[filePath] === undefined) {
      removed.push(filePath);
    }
  }
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  };
}

export function touchedPaths(diff: TreeDiff): readonly string[] {
  return [...diff.added, ...diff.removed, ...diff.changed].sort();
}

export function initGitRepo(root: string): string {
  const init = git(["init", "--initial-branch=main"], root);
  if (!init.ok) {
    throw new Error(`git init failed: ${init.stderr}`);
  }
  const configured = git(["config", "core.autocrlf", "false"], root);
  if (!configured.ok) {
    throw new Error(`git config failed: ${configured.stderr}`);
  }
  const name = git(["config", "user.name", "pi-hec"], root);
  if (!name.ok) {
    throw new Error(`git user.name failed: ${name.stderr}`);
  }
  const email = git(["config", "user.email", "hec@pi-hec.local"], root);
  if (!email.ok) {
    throw new Error(`git user.email failed: ${email.stderr}`);
  }
  const added = git(["add", "-A"], root);
  if (!added.ok) {
    throw new Error(`git add failed: ${added.stderr}`);
  }
  const committed = git(
    ["commit", "-m", "golden baseline", "--author", "pi-hec <hec@pi-hec.local>"],
    root,
  );
  if (!committed.ok) {
    throw new Error(`git commit failed: ${committed.stderr}`);
  }
  const head = git(["rev-parse", "HEAD"], root);
  if (!head.ok) {
    throw new Error(`git rev-parse failed: ${head.stderr}`);
  }
  return head.stdout.trim();
}
