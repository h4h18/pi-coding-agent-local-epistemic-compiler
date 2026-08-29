import { expect, test } from "vitest";
import {
  MODEL_CONTEXT_MISSING,
  buildInstructionManifest,
  buildScopeTrie,
  checkCompiledContextCoverage,
  discoverContextFiles,
  effectiveChainForPath,
  resolveCapabilityPolicy,
} from "../src/index.js";
import { SNAPSHOT_ID, file, utf8 } from "./helpers.js";

function trie(options: {
  projectTrusted?: boolean;
  nodes: Parameters<typeof discoverContextFiles>[0]["nodes"];
  globalSources?: Parameters<typeof discoverContextFiles>[0]["globalSources"];
  changesetTouchedInstructionPaths?: readonly string[];
}) {
  const discovery = discoverContextFiles({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: options.projectTrusted ?? true,
    nodes: options.nodes,
    globalSources: options.globalSources,
    changesetTouchedInstructionPaths: options.changesetTouchedInstructionPaths,
  });
  return { discovery, trie: buildScopeTrie(discovery, SNAPSHOT_ID) };
}

test("effective chain for a nested touched path is global then root-to-leaf", () => {
  const built = trie({
    globalSources: [{ trust: "user", pathLabel: "AGENTS.md", bytes: utf8("user") }],
    nodes: [
      file("AGENTS.md", "root"),
      file("pkg/AGENTS.md", "pkg"),
      file("pkg/nested/src/a.ts", "code"),
    ],
  });
  const chain = effectiveChainForPath(built.trie, "pkg/nested/src/a.ts");
  expect(chain.map((item) => item.verbatimContent)).toEqual(["user", "root", "pkg"]);
  expect(chain.map((item) => item.precedence)).toEqual([0, 1, 2]);
  expect(chain.map((item) => item.sourceRef.origin)).toEqual(["artifact", "repository", "repository"]);
});

test("override in a child directory replaces only that directory layer", () => {
  const built = trie({
    nodes: [
      file("AGENTS.md", "root"),
      file("svc/AGENTS.md", "svc skipped"),
      file("svc/AGENTS.override.md", "svc override"),
      file("svc/handler.ts", "code"),
    ],
  });
  expect(effectiveChainForPath(built.trie, "svc/handler.ts").map((item) => item.verbatimContent)).toEqual([
    "root",
    "svc override",
  ]);
});

test("linked worktree chain does not double-apply the shadowed main-repo file", () => {
  const built = trie({
    nodes: [
      file("AGENTS.md", "main"),
      file("nested-wt/.git", "gitdir: /repo/.git/worktrees/nested-wt\n"),
      file("nested-wt/AGENTS.md", "worktree"),
      file("nested-wt/src/a.ts", "code"),
      file("other/src/b.ts", "code"),
    ],
  });
  expect(effectiveChainForPath(built.trie, "nested-wt/src/a.ts").map((item) => item.verbatimContent)).toEqual([
    "worktree",
  ]);
  expect(effectiveChainForPath(built.trie, "other/src/b.ts").map((item) => item.verbatimContent)).toEqual([
    "main",
  ]);
});

test("unseen applicable instruction for a touched path is MODEL_CONTEXT_MISSING", () => {
  const built = trie({
    nodes: [file("AGENTS.md", "root"), file("pkg/AGENTS.md", "pkg"), file("pkg/a.ts", "code")],
  });
  const compiled = new Set([built.discovery.files[0]?.id ?? ""]);
  const coverage = checkCompiledContextCoverage({
    trie: built.trie,
    touchedPaths: ["pkg/a.ts"],
    compiledInstructionIds: compiled,
  });
  expect(coverage.ok).toBe(false);
  if (!coverage.ok) {
    expect(coverage.code).toBe(MODEL_CONTEXT_MISSING);
    expect(coverage.missingInstructionIds.length).toBeGreaterThan(0);
  }
});

test("coverage passes when every applicable instruction was compiled", () => {
  const built = trie({
    nodes: [file("AGENTS.md", "root"), file("pkg/AGENTS.md", "pkg"), file("pkg/a.ts", "code")],
  });
  const coverage = checkCompiledContextCoverage({
    trie: built.trie,
    touchedPaths: ["pkg/a.ts", "README.md"],
    compiledInstructionIds: new Set(built.discovery.files.map((entry) => entry.id)),
  });
  expect(coverage).toEqual({ ok: true });
});

test("project instructions may narrow but never grant host shell network secrets promotion signing or deployment", () => {
  const built = trie({
    globalSources: [
      {
        trust: "platform",
        pathLabel: "AGENTS.md",
        bytes: utf8("---\nallow:\n  network: true\n  host-shell: true\n---\nplatform\n"),
      },
    ],
    nodes: [
      file(
        "AGENTS.md",
        "---\nallow:\n  network: true\n  host-shell: true\n  secret-egress: true\n  promotion: true\n  signing: true\n  deployment: true\ndeny:\n  host-shell: true\n  network: true\n---\nproject\n",
      ),
    ],
  });
  const chain = effectiveChainForPath(built.trie, "src/a.ts");
  const policy = resolveCapabilityPolicy(chain);
  expect(policy).toEqual({
    hostShell: false,
    secretEgress: false,
    network: false,
    promotion: false,
    signing: false,
    deployment: false,
  });
});

test("untrusted project allow-list cannot expand capability", () => {
  const built = trie({
    projectTrusted: false,
    nodes: [file("AGENTS.md", "---\nallow:\n  network: true\n---\nproject\n")],
  });
  const policy = resolveCapabilityPolicy(effectiveChainForPath(built.trie, "a.ts"));
  expect(policy.network).toBe(false);
  expect(effectiveChainForPath(built.trie, "a.ts")[0]?.trust).toBe("untrusted-data");
});

test("untrusted project deny still narrows platform allow", () => {
  const built = trie({
    projectTrusted: false,
    globalSources: [
      {
        trust: "platform",
        pathLabel: "AGENTS.md",
        bytes: utf8(
          "---\nallow:\n  host-shell: true\n  secret-egress: true\n  network: true\n  promotion: true\n  signing: true\n  deployment: true\n---\nplatform\n",
        ),
      },
    ],
    nodes: [
      file(
        "AGENTS.md",
        "---\nallow:\n  network: true\ndeny:\n  host-shell: true\n  secret-egress: true\n  network: true\n  promotion: true\n  signing: true\n  deployment: true\n---\nproject\n",
      ),
    ],
  });
  const chain = effectiveChainForPath(built.trie, "src/a.ts");
  expect(chain.map((item) => item.trust)).toEqual(["platform", "untrusted-data"]);
  expect(resolveCapabilityPolicy(chain)).toEqual({
    hostShell: false,
    secretEgress: false,
    network: false,
    promotion: false,
    signing: false,
    deployment: false,
  });
});

test("instruction manifest is schema-complete and deterministic", () => {
  const built = trie({
    nodes: [file("AGENTS.md", "root"), file("pkg/AGENTS.md", "pkg")],
  });
  const manifest = buildInstructionManifest(built.trie);
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.snapshotId).toBe(SNAPSHOT_ID);
  expect(manifest.instructions.map((item) => item.scope)).toEqual([".", "pkg"]);
  expect(manifest.instructions[0]?.precedence).toBeLessThan(manifest.instructions[1]?.precedence ?? 0);
});
