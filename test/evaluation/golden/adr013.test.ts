import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  compileRunComposition,
  lockProjectAdapterFromDocument,
  resolvedVerificationPacks,
} from "@pi-hec/domain";
import { compositionForGoldenTask } from "./composition.js";
import { workspaceOracleLeaks } from "./concealment.js";
import {
  goldenProjectFolderName,
  goldenProjectRoot,
  goldenProjectsParent,
  hooksRepoRoot,
  nestedObservedCwd,
  syncGoldenProjects,
} from "./persistent.js";
import { GOLDEN_REPOS } from "./repos.js";
import { git } from "./tree.js";
import { GOLDEN_REPO_IDS } from "./types.js";

const ADAPTER_PATH = ".pi/hec-adapter.yaml";
const FORBIDDEN_RELATIVE = [
  "broker.sqlite",
  "broker.lock",
  ".pi/extensions",
  ".pi/hec.json",
  "faex1",
  "native/runner",
  "PI_HYBRID_EPISTEMIC_COMPILER_IMPLEMENTATION_SPEC.md",
] as const;

function sameResolvedPath(left: string, right: string): boolean {
  return (
    path.resolve(left).replaceAll("\\", "/").toLowerCase() ===
    path.resolve(right).replaceAll("\\", "/").toLowerCase()
  );
}

const synced = syncGoldenProjects();
const hooksRoot = hooksRepoRoot();
const parent = goldenProjectsParent();

test("golden projects live in independent git repos above the PI-HEC tree", () => {
  expect(path.basename(hooksRoot)).toBe("hooks");
  expect(parent).toBe(path.dirname(hooksRoot));
  expect(synced).toHaveLength(GOLDEN_REPO_IDS.length);
  const roots = new Set<string>();
  for (const project of synced) {
    const expectedRoot = goldenProjectRoot(project.repoId);
    expect(project.root).toBe(expectedRoot);
    expect(path.dirname(project.root)).toBe(parent);
    expect(path.basename(project.root)).toBe(goldenProjectFolderName(project.repoId));
    expect(path.relative(hooksRoot, project.root).startsWith("..")).toBe(true);
    const gitDir = path.join(project.root, ".git");
    expect(statSync(gitDir).isDirectory()).toBe(true);
    const discovered = git(["rev-parse", "--show-toplevel"], nestedObservedCwd(project.root, project.repoId));
    expect(discovered.ok).toBe(true);
    expect(sameResolvedPath(discovered.stdout.trim(), project.root)).toBe(true);
    const hooksTop = git(["rev-parse", "--show-toplevel"], hooksRoot);
    expect(hooksTop.ok).toBe(true);
    expect(sameResolvedPath(hooksTop.stdout.trim(), project.root)).toBe(false);
    expect(roots.has(project.root)).toBe(false);
    roots.add(project.root);
  }
});

test("extracted golden repos do not contain PI-HEC control plane, broker state, or project-local HEC extensions", () => {
  for (const project of synced) {
    expect(workspaceOracleLeaks(project.root)).toEqual([]);
    for (const relative of FORBIDDEN_RELATIVE) {
      expect(existsSync(path.join(project.root, ...relative.split("/")))).toBe(false);
    }
    expect(project.baseline[ADAPTER_PATH]).toBeDefined();
    expect(project.baseline["AGENTS.md"]).toBeDefined();
    const adapterText = readFileSync(path.join(project.root, ...ADAPTER_PATH.split("/")), "utf8");
    expect(adapterText.includes("network.default")).toBe(false);
    const locked = lockProjectAdapterFromDocument(adapterText);
    expect(locked.tightened).toBe(true);
    expect(locked.adapter.network.default).toBe("deny");
    expect(locked.adapter.network.externalResearch).toBe("deny");
    expect(locked.adapter.project.id).toMatch(/^[a-z0-9][a-z0-9._-]*$/u);
    expect(Object.keys(GOLDEN_REPOS[project.repoId].files)).toContain(ADAPTER_PATH);
  }
});

test("verification packs after ADR-013 phase B come from the golden folder adapter, not PI-HEC defaults", () => {
  const react = synced.find((project) => project.repoId === "react-spa");
  const node = synced.find((project) => project.repoId === "node-backend");
  expect(react).toBeDefined();
  expect(node).toBeDefined();
  if (react === undefined || node === undefined) {
    throw new Error("expected react-spa and node-backend golden projects");
  }
  const reactAdapter = lockProjectAdapterFromDocument(
    readFileSync(path.join(react.root, ...ADAPTER_PATH.split("/")), "utf8"),
  ).adapter;
  const nodeAdapter = lockProjectAdapterFromDocument(
    readFileSync(path.join(node.root, ...ADAPTER_PATH.split("/")), "utf8"),
  ).adapter;
  const uiComposition = compositionForGoldenTask("ui", "react-spa");
  const reactResolved = resolvedVerificationPacks(uiComposition, reactAdapter);
  const nodeResolved = resolvedVerificationPacks(uiComposition, nodeAdapter);
  expect(reactResolved.map((pack) => pack.id)).toContain("web-ui");
  expect(nodeResolved.map((pack) => pack.id)).not.toContain("web-ui");
  const compiled = compileRunComposition({
    composition: uiComposition,
    adapter: reactAdapter,
    signals: { unstableBug: false, externalResearch: false, noTests: false },
  });
  expect(compiled.compiled.composition.verificationPacks).toContain("web-ui");
  expect(compiled.blocked).toBe(false);
});
