import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { resolve, sep } from "node:path";

export const DEFAULT_AGENT_OVERLAY_ROOT = "/var/lib/pi-hec/agents";

export type OverlayGitKind = "none" | "repo" | "worktree";

export type OverlayPorts = {
  listProcessCwds(): readonly { pid: number; cwd: string }[];
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  git(args: readonly string[], cwd?: string): { ok: boolean; stdout: string; stderr: string };
  mkdir(path: string): void;
  removeDir(path: string): void;
  exists(path: string): boolean;
  readText(path: string): string;
  gitKind(overlayPath: string): OverlayGitKind;
};

export type ProvisionWorkspaceOverlayInput = {
  overlayPath: string;
  branch: string;
  sourceRepo?: string;
  baseCommit?: string;
  ports?: OverlayPorts;
};

export type ReleaseWorkspaceOverlayResult = {
  overlayPath: string;
  reapedPids: readonly number[];
  removed: boolean;
};

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "pi-hec",
  GIT_AUTHOR_EMAIL: "hec@pi-hec.local",
  GIT_COMMITTER_NAME: "pi-hec",
  GIT_COMMITTER_EMAIL: "hec@pi-hec.local",
  GIT_CONFIG_NOSYSTEM: "1",
} as const;

export function overlayBranchFor(runId: string, nodeId: string): string {
  return `hec/${sanitizeSegment(runId)}/${sanitizeSegment(nodeId)}`;
}

export function overlayPathFor(root: string, runId: string, nodeId: string): string {
  return `${stripTrailingSep(root)}${sep}${sanitizeSegment(runId)}${sep}${sanitizeSegment(nodeId)}`;
}

export function createDefaultOverlayPorts(): OverlayPorts {
  return {
    listProcessCwds: listLinuxProcessCwds,
    signal(pid, signal) {
      try {
        process.kill(pid, signal);
      } catch {
        return;
      }
    },
    git: runGit,
    mkdir(path) {
      mkdirSync(path, { recursive: true });
    },
    removeDir(path) {
      rmSync(path, { recursive: true, force: true });
    },
    exists(path) {
      return existsSync(path);
    },
    readText(path) {
      return readFileSync(path, "utf8");
    },
    gitKind(overlayPath) {
      const gitPath = `${overlayPath}${sep}.git`;
      if (!existsSync(gitPath)) {
        return "none";
      }
      return lstatSync(gitPath).isFile() ? "worktree" : "repo";
    },
  };
}

export function provisionWorkspaceOverlay(input: ProvisionWorkspaceOverlayInput): string {
  const ports = input.ports ?? createDefaultOverlayPorts();
  const overlayPath = resolve(input.overlayPath);
  ports.mkdir(overlayPath);
  if (input.sourceRepo !== undefined && ports.exists(input.sourceRepo)) {
    const added = addWorktree(ports, input.sourceRepo, overlayPath, input.branch, input.baseCommit);
    if (added) {
      return overlayPath;
    }
  }
  initStandaloneOverlay(ports, overlayPath, input.branch);
  return overlayPath;
}

export function releaseWorkspaceOverlay(
  overlayPath: string,
  ports: OverlayPorts = createDefaultOverlayPorts(),
): ReleaseWorkspaceOverlayResult {
  const resolved = resolve(overlayPath);
  const reapedPids = reapOverlayProcesses(resolved, ports);
  if (ports.exists(resolved) && ports.gitKind(resolved) === "worktree") {
    removeWorktree(ports, resolved);
  }
  if (ports.exists(resolved)) {
    ports.removeDir(resolved);
  }
  return { overlayPath: resolved, reapedPids, removed: !ports.exists(resolved) };
}

export function sweepOrphanOverlays(input: {
  root: string;
  keepOverlayPaths?: ReadonlySet<string>;
  ports?: OverlayPorts;
}): { released: readonly ReleaseWorkspaceOverlayResult[] } {
  const ports = input.ports ?? createDefaultOverlayPorts();
  const keep = new Set(
    [...(input.keepOverlayPaths ?? [])].map((path) => resolve(path).toLowerCase()),
  );
  const released: ReleaseWorkspaceOverlayResult[] = [];
  if (!ports.exists(input.root)) {
    return { released };
  }
  for (const overlayPath of listOverlayLeaves(input.root, ports)) {
    if (keep.has(resolve(overlayPath).toLowerCase())) {
      continue;
    }
    released.push(releaseWorkspaceOverlay(overlayPath, ports));
  }
  pruneEmptyRunDirs(input.root, ports);
  return { released };
}

function pruneEmptyRunDirs(root: string, ports: OverlayPorts): void {
  const rootResolved = resolve(root);
  let runDirs: string[];
  try {
    runDirs = readdirSync(rootResolved, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return;
  }
  for (const runId of runDirs) {
    const runPath = `${rootResolved}${sep}${runId}`;
    try {
      if (readdirSync(runPath).length === 0) {
        ports.removeDir(runPath);
      }
    } catch {
      continue;
    }
  }
}

export function reapOverlayProcesses(
  overlayPath: string,
  ports: OverlayPorts = createDefaultOverlayPorts(),
): number[] {
  const overlay = resolve(overlayPath);
  const pids = ports
    .listProcessCwds()
    .filter((entry) => entry.pid !== process.pid && cwdInsideOverlay(entry.cwd, overlay))
    .map((entry) => entry.pid);
  for (const pid of pids) {
    ports.signal(pid, "SIGTERM");
  }
  for (const pid of pids) {
    ports.signal(pid, "SIGKILL");
  }
  return pids;
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-");
  if (cleaned.length === 0) {
    throw new Error("overlay path segment is empty");
  }
  return cleaned;
}

function stripTrailingSep(value: string): string {
  return value.endsWith("/") || value.endsWith("\\") ? value.slice(0, -1) : value;
}

function cwdInsideOverlay(cwd: string, overlay: string): boolean {
  const actual = resolve(cwd);
  return actual === overlay || actual.startsWith(overlay + sep);
}

function listLinuxProcessCwds(): { pid: number; cwd: string }[] {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  const listed: { pid: number; cwd: string }[] = [];
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) {
      continue;
    }
    try {
      listed.push({ pid: Number(entry), cwd: readlinkSync(`/proc/${entry}/cwd`) });
    } catch {
      continue;
    }
  }
  return listed;
}

function runGit(args: readonly string[], cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    env: { ...process.env, ...GIT_IDENTITY },
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function addWorktree(
  ports: OverlayPorts,
  sourceRepo: string,
  overlayPath: string,
  branch: string,
  baseCommit: string | undefined,
): boolean {
  const args = ["worktree", "add", "--force", "-B", branch, overlayPath];
  if (baseCommit !== undefined && baseCommit.length > 0 && baseCommit !== "base") {
    args.push(baseCommit);
  }
  return ports.git(args, sourceRepo).ok;
}

function initStandaloneOverlay(ports: OverlayPorts, overlayPath: string, branch: string): void {
  if (ports.gitKind(overlayPath) === "none") {
    ports.git(["init", "--initial-branch", branch], overlayPath);
    if (ports.gitKind(overlayPath) === "none") {
      ports.git(["init"], overlayPath);
      ports.git(["checkout", "--orphan", branch], overlayPath);
    }
  } else {
    ports.git(["checkout", "-B", branch], overlayPath);
  }
  ports.git(["commit", "--allow-empty", "-m", "hec overlay baseline"], overlayPath);
}

function removeWorktree(ports: OverlayPorts, overlayPath: string): void {
  const gitFile = `${overlayPath}${sep}.git`;
  if (!ports.exists(gitFile)) {
    return;
  }
  const parsed = parseGitdir(ports.readText(gitFile));
  if (parsed === undefined) {
    return;
  }
  const branch = currentBranchFromWorktreeName(overlayPath);
  ports.git(["worktree", "remove", "--force", overlayPath], parsed.repoRoot);
  ports.git(["worktree", "prune"], parsed.repoRoot);
  if (branch !== undefined) {
    ports.git(["branch", "-D", branch], parsed.repoRoot);
  }
}

function parseGitdir(contents: string): { repoRoot: string } | undefined {
  const match = /^gitdir:\s*(.+)$/m.exec(contents);
  if (match === null || match[1] === undefined) {
    return undefined;
  }
  const normalized = match[1].trim().replace(/\\/g, "/");
  const worktree = /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(normalized);
  if (worktree === null || worktree[1] === undefined || worktree[1].length === 0) {
    return undefined;
  }
  return { repoRoot: worktree[1] };
}

function currentBranchFromWorktreeName(overlayPath: string): string | undefined {
  const parts = resolve(overlayPath).split(/[/\\]/).filter((part) => part.length > 0);
  if (parts.length < 2) {
    return undefined;
  }
  const nodeId = parts[parts.length - 1];
  const runId = parts[parts.length - 2];
  if (nodeId === undefined || runId === undefined) {
    return undefined;
  }
  return overlayBranchFor(runId, nodeId);
}

function listOverlayLeaves(root: string, ports: OverlayPorts): string[] {
  const overlays: string[] = [];
  const rootResolved = resolve(root);
  let runDirs: string[];
  try {
    runDirs = readdirSync(rootResolved, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return overlays;
  }
  for (const runId of runDirs) {
    const runPath = `${rootResolved}${sep}${runId}`;
    let nodeDirs: string[];
    try {
      nodeDirs = readdirSync(runPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const nodeId of nodeDirs) {
      const overlayPath = `${runPath}${sep}${nodeId}`;
      if (ports.exists(overlayPath)) {
        overlays.push(overlayPath);
      }
    }
  }
  return overlays;
}
