import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeWorkspaceFixture } from "./workspace-fixture.ts";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const scriptUrl = pathToFileURL(path.join(repoRoot, "scripts", "check-dependency-graph.ts")).href;

async function loadGraphScript(): Promise<{
  inspectWorkspace: (rootDir: string) => {
    ok: boolean;
    issues: readonly { kind: string; message: string }[];
  };
}> {
  return import(scriptUrl) as Promise<{
    inspectWorkspace: (rootDir: string) => {
      ok: boolean;
      issues: readonly { kind: string; message: string }[];
    };
  }>;
}

void test("rejects a forbidden production package edge", async () => {
  const { inspectWorkspace } = await loadGraphScript();
  const rootDir = await mkdtemp(path.join(tmpdir(), "hec-forbidden-edge-"));
  try {
    await writeWorkspaceFixture(rootDir, {
      packages: {
        contracts: {
          dependencies: { "@pi-hec/domain": "0.0.0" },
        },
        domain: {},
      },
    });
    const report = inspectWorkspace(rootDir);
    assert.equal(report.ok, false);
    assert.ok(
      report.issues.some((issue) => issue.kind === "forbidden-edge"),
      report.issues.map((issue) => issue.message).join("\n"),
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

void test("rejects a production dependency that uses a caret range", async () => {
  const { inspectWorkspace } = await loadGraphScript();
  const rootDir = await mkdtemp(path.join(tmpdir(), "hec-caret-version-"));
  try {
    await writeWorkspaceFixture(rootDir, {
      packages: {
        contracts: {
          dependencies: { pino: "^10.3.1" },
        },
      },
    });
    const report = inspectWorkspace(rootDir);
    assert.equal(report.ok, false);
    assert.ok(
      report.issues.some((issue) => issue.kind === "ranged-version"),
      report.issues.map((issue) => issue.message).join("\n"),
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

void test("rejects a circular production package dependency", async () => {
  const { inspectWorkspace } = await loadGraphScript();
  const rootDir = await mkdtemp(path.join(tmpdir(), "hec-cycle-"));
  try {
    await writeWorkspaceFixture(rootDir, {
      packages: {
        domain: {
          dependencies: { "@pi-hec/state-store": "0.0.0" },
        },
        "state-store": {
          dependencies: { "@pi-hec/domain": "0.0.0" },
        },
      },
    });
    const report = inspectWorkspace(rootDir);
    assert.equal(report.ok, false);
    assert.ok(
      report.issues.some((issue) => issue.kind === "cycle"),
      report.issues.map((issue) => issue.message).join("\n"),
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

void test("repository workspace matches the allowed dependency graph", async () => {
  const { inspectWorkspace } = await loadGraphScript();
  const report = inspectWorkspace(repoRoot);
  assert.equal(report.ok, true, report.issues.map((issue) => issue.message).join("\n"));
});

void test("rejects a Cargo path dependency from pi-hec-runner to an unknown crate", async () => {
  const { inspectWorkspace } = await loadGraphScript();
  const rootDir = await mkdtemp(path.join(tmpdir(), "hec-cargo-unknown-path-"));
  try {
    await writeWorkspaceFixture(rootDir, {
      packages: { contracts: {} },
    });
    await mkdir(path.join(rootDir, "native", "runner"), { recursive: true });
    await writeFile(
      path.join(rootDir, "Cargo.toml"),
      `[workspace]\nresolver = "3"\nmembers = ["native/runner"]\n`,
      "utf8",
    );
    await writeFile(
      path.join(rootDir, "native", "runner", "Cargo.toml"),
      `[package]\nname = "pi-hec-runner"\nversion = "0.0.0"\nedition = "2024"\n\n[dependencies]\nmystery-crate = { path = "../mystery-crate" }\n`,
      "utf8",
    );
    const report = inspectWorkspace(rootDir);
    assert.equal(report.ok, false);
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.kind === "forbidden-edge" &&
          /pi-hec-runner/.test(issue.message) &&
          /mystery-crate/.test(issue.message),
      ),
      report.issues.map((issue) => issue.message).join("\n"),
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

void test("allows the spec Cargo workspace member with no extra path dependencies", async () => {
  const { inspectWorkspace } = await loadGraphScript();
  const rootDir = await mkdtemp(path.join(tmpdir(), "hec-cargo-runner-only-"));
  try {
    await writeWorkspaceFixture(rootDir, {
      packages: { contracts: {} },
    });
    await mkdir(path.join(rootDir, "native", "runner"), { recursive: true });
    await writeFile(
      path.join(rootDir, "Cargo.toml"),
      `[workspace]\nresolver = "3"\nmembers = ["native/runner"]\n`,
      "utf8",
    );
    await writeFile(
      path.join(rootDir, "native", "runner", "Cargo.toml"),
      `[package]\nname = "pi-hec-runner"\nversion = "0.0.0"\nedition = "2024"\n`,
      "utf8",
    );
    const report = inspectWorkspace(rootDir);
    assert.equal(report.ok, true, report.issues.map((issue) => issue.message).join("\n"));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
