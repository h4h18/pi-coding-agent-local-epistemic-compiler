import { expect, test } from "vitest";
import {
  CONTEXT_FILE_CANDIDATES,
  buildScopeTrie,
  discoverContextFiles,
  effectiveChainForPath,
  nodesFromSnapshotEntries,
} from "../src/index.js";
import { SNAPSHOT_ID, file, symlink, utf8 } from "./helpers.js";

test("Pi v0.84.3 candidate order is override then AGENTS then CLAUDE case variants", () => {
  expect([...CONTEXT_FILE_CANDIDATES]).toEqual([
    "AGENTS.override.md",
    "AGENTS.md",
    "AGENTS.MD",
    "CLAUDE.md",
    "CLAUDE.MD",
  ]);
});

test("per-directory first existing file wins and other directories still layer", () => {
  const result = discoverContextFiles({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [
      file("AGENTS.md", "root agents"),
      file("AGENTS.MD", "root agents md"),
      file("CLAUDE.md", "root claude"),
      file("pkg/AGENTS.md", "pkg agents"),
      file("pkg/AGENTS.override.md", "pkg override"),
      file("pkg/CLAUDE.md", "pkg claude"),
      file("pkg/nested/CLAUDE.MD", "nested claude md"),
      file("pkg/nested/CLAUDE.md", "nested claude"),
    ],
  });
  expect(result.files.map((entry) => entry.path)).toEqual([
    "AGENTS.md",
    "pkg/AGENTS.override.md",
    "pkg/nested/CLAUDE.md",
  ]);
  expect(result.files.map((entry) => entry.scope)).toEqual([".", "pkg", "pkg/nested"]);
  expect(result.files[1]?.body).toBe("pkg override");
});

test("AGENTS.MD is selected when AGENTS.md is absent and beats CLAUDE.md", () => {
  const result = discoverContextFiles({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [file("AGENTS.MD", "agents md"), file("CLAUDE.md", "claude")],
  });
  expect(result.files).toHaveLength(1);
  expect(result.files[0]?.path).toBe("AGENTS.MD");
});

test("global context loads first then root-to-leaf", () => {
  const result = discoverContextFiles({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [file("lib/AGENTS.md", "lib"), file("AGENTS.md", "root")],
    globalSources: [
      {
        trust: "platform",
        pathLabel: "AGENTS.md",
        bytes: utf8("platform policy"),
      },
      {
        trust: "user",
        pathLabel: "AGENTS.override.md",
        bytes: utf8("user override"),
      },
    ],
  });
  expect(result.files.map((entry) => entry.trust)).toEqual([
    "platform",
    "user",
    "trusted-project",
    "trusted-project",
  ]);
  expect(result.files.map((entry) => entry.body)).toEqual([
    "platform policy",
    "user override",
    "root",
    "lib",
  ]);
});

test("untrusted project instructions are indexed without expanding capability", () => {
  const result = discoverContextFiles({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: false,
    nodes: [
      file(
        "AGENTS.md",
        "---\nallow:\n  network: true\n  host-shell: true\n---\nproject workflow\n",
      ),
    ],
  });
  expect(result.files[0]?.trust).toBe("untrusted-data");
  expect(result.files[0]?.body).toContain("project workflow");
});

test("changeset-touched instruction paths are excluded from the current run", () => {
  const result = discoverContextFiles({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    changesetTouchedInstructionPaths: ["pkg/AGENTS.md"],
    nodes: [file("AGENTS.md", "root"), file("pkg/AGENTS.md", "changed")],
  });
  expect(result.files.map((entry) => entry.path)).toEqual(["AGENTS.md"]);
});

test("symlink or junction at an instruction path is not followed", () => {
  const result = discoverContextFiles({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [
      symlink("AGENTS.md", "outside/AGENTS.md"),
      file("pkg/CLAUDE.md", "real"),
      symlink("pkg/AGENTS.md", "../outside/AGENTS.md"),
    ],
  });
  expect(result.files.map((entry) => entry.path)).toEqual(["pkg/CLAUDE.md"]);
});

test("instruction file under a symlink ancestor is ignored", () => {
  const result = discoverContextFiles({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [
      symlink("linked", "outside"),
      file("linked/AGENTS.md", "should not load"),
      file("AGENTS.md", "root"),
    ],
  });
  expect(result.files.map((entry) => entry.path)).toEqual(["AGENTS.md"]);
});

test("linked nested worktree shadows the main repo context file with the same basename", () => {
  const result = discoverContextFiles({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [
      file("AGENTS.md", "main repo agents"),
      file("nested-wt/.git", "gitdir: /tmp/main/.git/worktrees/nested-wt\n"),
      file("nested-wt/AGENTS.md", "worktree agents"),
      file("nested-wt/src/app.ts", "code"),
    ],
  });
  expect(result.files.map((entry) => entry.path)).toEqual(["AGENTS.md", "nested-wt/AGENTS.md"]);
  expect(result.worktreeShadows.map((shadow) => shadow.shadowedPath)).toEqual(["AGENTS.md"]);
});

test("empty first-existing override stays in the chain and does not fall through", () => {
  const result = discoverContextFiles({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [
      file("AGENTS.md", "root"),
      file("pkg/AGENTS.override.md", ""),
      file("pkg/AGENTS.md", "must not win"),
      file("pkg/src/a.ts", "code"),
    ],
  });
  expect(result.files.map((entry) => entry.path)).toEqual(["AGENTS.md", "pkg/AGENTS.override.md"]);
  expect(result.files[1]?.body).toBe("");
  expect(result.collisions).toEqual([]);
  const chain = effectiveChainForPath(buildScopeTrie(result, SNAPSHOT_ID), "pkg/src/a.ts");
  expect(chain.map((item) => item.path)).toEqual(["AGENTS.md", "pkg/AGENTS.override.md"]);
  expect(chain[1]?.verbatimContent).toBe("");
});

test("invalid first-existing override skips the directory without falling through", () => {
  const longDir = "x".repeat(2000);
  const overridePath = `${longDir}/AGENTS.override.md`;
  const fallbackPath = `${longDir}/AGENTS.md`;
  const result = discoverContextFiles({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [
      file("AGENTS.md", "root"),
      file(overridePath, "override body"),
      file(fallbackPath, "must not win"),
      file(`${longDir}/src/a.ts`, "code"),
    ],
  });
  expect(result.files.map((entry) => entry.path)).toEqual(["AGENTS.md"]);
  expect(result.collisions.some((item) => item.paths.includes(overridePath))).toBe(true);
  expect(
    result.collisions.some((item) =>
      item.reason.includes("directory skipped without falling through"),
    ),
  ).toBe(true);
  expect(result.files.some((entry) => entry.path === fallbackPath)).toBe(false);
  const chain = effectiveChainForPath(buildScopeTrie(result, SNAPSHOT_ID), `${longDir}/src/a.ts`);
  expect(chain.map((item) => item.path)).toEqual(["AGENTS.md"]);
});

test("Unicode NFC collisions of the same candidate are explicit conflicts", () => {
  const nfc = "pkg/cafe\u0301";
  const result = discoverContextFiles({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [file(`${nfc}/AGENTS.md`, "nfd"), file("pkg/café/AGENTS.md", "nfc")],
  });
  expect(result.files).toHaveLength(0);
  expect(result.collisions.length).toBeGreaterThan(0);
});

test("nodesFromSnapshotEntries keeps symlink entries as non-files", () => {
  const digest = "sha256:" + "ab".repeat(32);
  const nodes = nodesFromSnapshotEntries(
    [
      {
        path: "AGENTS.md",
        entryType: "symlink",
        symlinkTarget: "other.md",
        gitMode: "120000",
        platformMetadata: {
          kind: "posix",
          device: "d",
          inode: "i",
          mode: 41453,
          ownerId: 0,
          groupId: 0,
          xattrsDigest: digest,
        },
      },
      {
        path: "README.md",
        entryType: "file",
        contentDigest: digest,
        size: 4,
        gitMode: "100644",
        storage: { kind: "blob", objectDigest: digest },
        platformMetadata: {
          kind: "posix",
          device: "d",
          inode: "i2",
          mode: 33188,
          ownerId: 0,
          groupId: 0,
          xattrsDigest: digest,
        },
      },
    ],
    new Map([["README.md", utf8("docs")]]),
  );
  expect(nodes).toEqual([
    { path: "AGENTS.md", kind: "symlink", target: "other.md" },
    { path: "README.md", kind: "file", bytes: utf8("docs") },
  ]);
});
