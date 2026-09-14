import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertWorkspaceConcealed } from "./concealment.js";
import { GOLDEN_REPOS, repoDefinition, type GoldenRepoDefinition } from "./repos.js";
import {
  FEATURE_SESSION,
  GOLD_SESSION,
  MIGRATION_002,
  PERFORMANCE_SESSION,
  REFACTOR_SESSION,
  REFACTOR_TOKEN_ORDER,
  REGRESSION_TEST,
  SAFE_ECHO,
  SAFE_UI,
  SAFE_UI_REACT,
  SPEC_AUTH,
} from "./sources.js";
import { initGitRepo, snapshotTree, writeTree } from "./tree.js";
import type {
  GoldenRepoId,
  GoldenTask,
  HiddenOracle,
  MaterializedRepo,
  RepoPaths,
  TaskKind,
} from "./types.js";
import { GOLDEN_REPO_IDS, TASK_KINDS } from "./types.js";

function regressionTestPath(paths: RepoPaths): string {
  const sessionDir = paths.session.split("/").slice(0, -1).join("/");
  return `${sessionDir}/refresh.regression.test.ts`;
}

function safeUi(paths: RepoPaths): string {
  if (paths.ui === undefined) {
    return SAFE_UI;
  }
  if (paths.ui.endsWith("login.ts") && paths.ui.includes("ui/")) {
    return SAFE_UI_REACT;
  }
  return SAFE_UI;
}

function bugOracle(paths: RepoPaths): HiddenOracle {
  const testPath = regressionTestPath(paths);
  return {
    mustChange: [paths.session, testPath],
    mustNotChange: [paths.publicApi, paths.canary],
    requiredBehavior: ["concurrent-refresh-preserves-newest-token"],
    forbiddenBehavior: ["global-request-serialization", "public-api-break", "test-poisoning"],
    requiredEvidence: ["regression-test"],
    solverEdits: {
      [paths.session]: GOLD_SESSION,
      [testPath]: REGRESSION_TEST,
    },
  };
}

function featureOracle(paths: RepoPaths): HiddenOracle {
  return {
    mustChange: [paths.session],
    mustNotChange: [paths.publicApi, paths.canary],
    requiredBehavior: ["remember-me-persists-across-reload"],
    forbiddenBehavior: ["global-request-serialization", "public-api-break", "test-poisoning"],
    requiredEvidence: ["regression-test"],
    solverEdits: {
      [paths.session]: FEATURE_SESSION,
    },
  };
}

function refactorOracle(paths: RepoPaths): HiddenOracle {
  const tokenOrder = paths.tokenOrder ?? "src/auth/token-order.ts";
  return {
    mustChange: [paths.session, tokenOrder],
    mustNotChange: [paths.publicApi, paths.canary],
    requiredBehavior: ["module-extracted-token-order"],
    forbiddenBehavior: ["global-request-serialization", "public-api-break", "test-poisoning"],
    requiredEvidence: ["review-findings"],
    solverEdits: {
      [tokenOrder]: REFACTOR_TOKEN_ORDER,
      [paths.session]: REFACTOR_SESSION,
    },
  };
}

function specOracle(paths: RepoPaths): HiddenOracle {
  const specPath = paths.specs ?? "specs/auth.md";
  return {
    mustChange: [specPath],
    mustNotChange: [paths.publicApi, paths.canary],
    requiredBehavior: ["spec-names-newest-token-rule"],
    forbiddenBehavior: ["public-api-break", "test-poisoning"],
    requiredEvidence: ["spec-update"],
    solverEdits: {
      [specPath]: SPEC_AUTH,
    },
  };
}

function researchOracle(paths: RepoPaths): HiddenOracle {
  return {
    mustChange: [],
    mustNotChange: [paths.session, paths.publicApi, paths.canary],
    requiredBehavior: ["research-no-production-edits"],
    forbiddenBehavior: ["public-api-break", "test-poisoning"],
    requiredEvidence: ["investigation-report"],
    solverEdits: {},
  };
}

function securityOracle(paths: RepoPaths): HiddenOracle {
  const sink = paths.security ?? paths.ui ?? "src/http/echo.ts";
  const safe = sink.includes("echo") ? SAFE_ECHO : safeUi(paths);
  return {
    mustChange: [sink],
    mustNotChange: [paths.publicApi, paths.canary],
    requiredBehavior: ["xss-sink-sanitized"],
    forbiddenBehavior: ["public-api-break", "test-poisoning"],
    requiredEvidence: ["review-findings"],
    solverEdits: {
      [sink]: safe,
    },
  };
}

function migrationOracle(paths: RepoPaths): HiddenOracle {
  return {
    mustChange: ["migrations/002_add_epoch.sql"],
    mustNotChange: [paths.publicApi, paths.canary],
    requiredBehavior: ["migration-is-additive"],
    forbiddenBehavior: ["public-api-break", "test-poisoning"],
    requiredEvidence: ["migration-file"],
    solverEdits: {
      "migrations/002_add_epoch.sql": MIGRATION_002,
    },
  };
}

function uiOracle(paths: RepoPaths): HiddenOracle {
  const uiPath = paths.ui ?? "src/cli/banner.ts";
  return {
    mustChange: [uiPath],
    mustNotChange: [paths.publicApi, paths.canary],
    requiredBehavior: ["login-control-is-accessible"],
    forbiddenBehavior: ["public-api-break", "test-poisoning"],
    requiredEvidence: ["command-evidence"],
    solverEdits: {
      [uiPath]: uiPath.includes("banner")
        ? `export function banner(): string {\n  return '<button type="button" aria-label="Sign in">Sign in</button>';\n}\n`
        : SAFE_UI_REACT.replace("name: string", "name: string"),
    },
  };
}

function performanceOracle(paths: RepoPaths): HiddenOracle {
  return {
    mustChange: [paths.session],
    mustNotChange: [paths.publicApi, paths.canary],
    requiredBehavior: ["refresh-is-amortized"],
    forbiddenBehavior: ["global-request-serialization", "public-api-break", "test-poisoning"],
    requiredEvidence: ["command-evidence"],
    solverEdits: {
      [paths.session]: PERFORMANCE_SESSION,
    },
  };
}

function oracleFor(kind: TaskKind, paths: RepoPaths): HiddenOracle {
  switch (kind) {
    case "feature":
      return featureOracle(paths);
    case "bug":
      return bugOracle(paths);
    case "refactor":
      return refactorOracle(paths);
    case "spec":
      return specOracle(paths);
    case "research":
      return researchOracle(paths);
    case "security":
      return securityOracle(paths);
    case "migration":
      return migrationOracle(paths);
    case "ui":
      return uiOracle(paths);
    case "performance":
      return performanceOracle(paths);
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function promptFor(repo: GoldenRepoDefinition, kind: TaskKind): string {
  const { paths, title } = repo;
  switch (kind) {
    case "feature":
      return `In ${title}, add remember-me so a stored token can be restored after reload. Do not change ${paths.publicApi}.`;
    case "bug":
      return `In ${title}, overlapping session refreshes must keep the newest token. Do not change ${paths.publicApi}.`;
    case "refactor":
      return `In ${title}, extract issued-at comparison into its own module without breaking ${paths.publicApi}.`;
    case "spec":
      return `In ${title}, write the overlapping-refresh rule into the spec. Do not break ${paths.publicApi}.`;
    case "research":
      return `In ${title}, report how overlapping refreshes currently behave. Do not edit production source.`;
    case "security":
      return `In ${title}, stop echoing unsanitized markup in the login/echo surface. Do not change ${paths.publicApi}.`;
    case "migration":
      return `In ${title}, add an additive migration for a session epoch column without breaking ${paths.publicApi}.`;
    case "ui":
      return `In ${title}, make the login/status control an accessible button with an accessible name. Do not change ${paths.publicApi}.`;
    case "performance":
      return `In ${title}, make expiry scanning linear in the number of sessions. Do not change ${paths.publicApi}.`;
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function withDirtyConstraint(oracle: HiddenOracle, paths: RepoPaths): HiddenOracle {
  if (paths.dirty === undefined) {
    return oracle;
  }
  return {
    ...oracle,
    mustNotChange: [...new Set([...oracle.mustNotChange, paths.dirty])],
  };
}

function withIncompleteAgents(oracle: HiddenOracle, kind: TaskKind): HiddenOracle {
  if (kind === "bug" || kind === "research" || kind === "feature") {
    return { ...oracle, expectedDisposition: "BLOCKED" };
  }
  return oracle;
}

function specialize(repo: GoldenRepoDefinition, kind: TaskKind, oracle: HiddenOracle): HiddenOracle {
  let next = withDirtyConstraint(oracle, repo.paths);
  if (repo.id === "incomplete-agents") {
    next = withIncompleteAgents(next, kind);
  }
  if (repo.id === "no-tests" && (kind === "bug" || kind === "feature" || kind === "performance")) {
    next = { ...next, requiredEvidence: [...new Set([...next.requiredEvidence, "regression-test"])] };
  }
  return next;
}

export function taskIdFor(repoId: GoldenRepoId, kind: TaskKind): string {
  return `golden/${repoId}/${kind}`;
}

export function buildCatalog(): readonly GoldenTask[] {
  const tasks: GoldenTask[] = [];
  for (const repoId of GOLDEN_REPO_IDS) {
    const repo = repoDefinition(repoId);
    for (const kind of TASK_KINDS) {
      const oracle = specialize(repo, kind, oracleFor(kind, repo.paths));
      tasks.push({
        taskId: taskIdFor(repoId, kind),
        repoId,
        kind,
        prompt: promptFor(repo, kind),
        oracle,
      });
    }
  }
  return tasks;
}

export const GOLDEN_TASKS: readonly GoldenTask[] = buildCatalog();

export function goldenTask(taskId: string): GoldenTask {
  const task = GOLDEN_TASKS.find((item) => item.taskId === taskId);
  if (task === undefined) {
    throw new Error(`unknown golden task ${taskId}`);
  }
  return task;
}

export function materializeGoldenRepo(
  repoId: GoldenRepoId,
  dest?: string,
): MaterializedRepo {
  const repo = GOLDEN_REPOS[repoId];
  const root = dest ?? mkdtempSync(path.join(tmpdir(), `golden-${repoId}-`));
  writeTree(root, repo.files);
  const head = initGitRepo(root);
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
  };
}
