import { expect, test } from "vitest";
import {
  discoverContextFiles,
  discoverSkills,
  effectiveChainForPath,
  buildScopeTrie,
  resolveSkills,
} from "../src/index.js";
import { SNAPSHOT_ID, file, skillMarkdown } from "./helpers.js";

function skillDoc(
  name: string,
  description: string,
  extraFrontmatter = "",
  body = "instructions",
): string {
  const extra = extraFrontmatter.length > 0 ? `\n${extraFrontmatter}` : "";
  return `---\nname: ${name}\ndescription: ${description}${extra}\n---\n\n${body}\n`;
}

test("mandatory trusted instruction skills are included with full bodies first", () => {
  const discovery = discoverSkills({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [
      file(".pi/skills/must/SKILL.md", skillDoc("must-skill", "Always load")),
      file(".pi/skills/other/SKILL.md", skillDoc("other-skill", "Optional")),
    ],
  });
  const instructions = discoverContextFiles({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [
      file("AGENTS.md", "---\nmandatory-skills:\n  - must-skill\n---\nUse must-skill.\n"),
    ],
  });
  const chain = effectiveChainForPath(buildScopeTrie(instructions, SNAPSHOT_ID), "src/a.ts");
  const resolved = resolveSkills({
    snapshotId: SNAPSHOT_ID,
    discovery,
    instructionChain: chain,
    touchedPaths: ["src/a.ts"],
    tokenBudget: 10_000,
  });
  expect(resolved.manifest.skills.map((skill) => skill.id)).toEqual(["must-skill", "other-skill"]);
  expect(resolved.loadedSkills.map((item) => item.skillId)).toEqual(["must-skill"]);
  expect(resolved.loadedSkills[0]?.verbatimContent).toContain("Always load");
  expect(resolved.omittedSkillIds).toEqual(["other-skill"]);
});

test("exact path-scoped skills beat generic applicability", () => {
  const discovery = discoverSkills({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [
      file(
        ".pi/skills/scoped/SKILL.md",
        skillDoc("path-skill", "Only for pkg", "scope: pkg"),
      ),
      file(".pi/skills/generic/SKILL.md", skillDoc("generic-skill", "Everywhere")),
    ],
  });
  const resolved = resolveSkills({
    snapshotId: SNAPSHOT_ID,
    discovery,
    instructionChain: [],
    touchedPaths: ["pkg/src/a.ts"],
    tokenBudget: 10_000,
  });
  expect(resolved.loadedSkills.map((item) => item.skillId)).toEqual(["path-skill"]);
  expect(resolved.manifest.skills.find((skill) => skill.id === "path-skill")?.loadPolicy).toBe(
    "applicable",
  );
});

test("applicability proven by evidence plus dependency closure", () => {
  const discovery = discoverSkills({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [
      file(".pi/skills/base/SKILL.md", skillDoc("base-skill", "Base helper")),
      file(
        ".pi/skills/app/SKILL.md",
        skillDoc("app-skill", "Application", "depends:\n  - base-skill"),
      ),
      file(".pi/skills/idle/SKILL.md", skillDoc("idle-skill", "Idle")),
    ],
  });
  const resolved = resolveSkills({
    snapshotId: SNAPSHOT_ID,
    discovery,
    instructionChain: [],
    touchedPaths: ["src/a.ts"],
    provenSkillIds: ["app-skill"],
    tokenBudget: 10_000,
  });
  expect(resolved.loadedSkills.map((item) => item.skillId)).toEqual(["app-skill", "base-skill"]);
  expect(resolved.omittedSkillIds).toEqual(["idle-skill"]);
});

test("dependency cycles are explicit conflicts", () => {
  const discovery = discoverSkills({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [
      file(
        ".pi/skills/a/SKILL.md",
        skillDoc("cycle-a", "A", "depends:\n  - cycle-b"),
      ),
      file(
        ".pi/skills/b/SKILL.md",
        skillDoc("cycle-b", "B", "depends:\n  - cycle-a"),
      ),
    ],
  });
  const resolved = resolveSkills({
    snapshotId: SNAPSHOT_ID,
    discovery,
    instructionChain: [],
    touchedPaths: ["src/a.ts"],
    provenSkillIds: ["cycle-a"],
    tokenBudget: 10_000,
  });
  expect(resolved.manifest.conflicts.some((item) => item.reason.toLowerCase().includes("cycle"))).toBe(
    true,
  );
  expect(resolved.loadedSkills).toHaveLength(0);
});

test("local model proposals cannot admit unknown or conflicting skills", () => {
  const discovery = discoverSkills({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [file(".pi/skills/real/SKILL.md", skillMarkdown("real-skill", "Real"))],
  });
  const resolved = resolveSkills({
    snapshotId: SNAPSHOT_ID,
    discovery,
    instructionChain: [],
    touchedPaths: ["src/a.ts"],
    proposedSkillIds: ["real-skill", "hallucinated-skill"],
    tokenBudget: 10_000,
  });
  expect(resolved.manifest.skills.map((skill) => skill.id)).toEqual(["real-skill"]);
  expect(resolved.loadedSkills).toHaveLength(0);
  expect(resolved.omittedSkillIds).toEqual(["real-skill"]);
});

test("oversized bodies conflict instead of truncating", () => {
  const huge = "x".repeat(4096);
  const discovery = discoverSkills({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [file(".pi/skills/huge/SKILL.md", skillDoc("huge-skill", "Huge", "", huge))],
  });
  const resolved = resolveSkills({
    snapshotId: SNAPSHOT_ID,
    discovery,
    instructionChain: [],
    touchedPaths: ["src/a.ts"],
    provenSkillIds: ["huge-skill"],
    tokenBudget: 10_000,
    maxSkillBodyBytes: 128,
  });
  expect(resolved.manifest.conflicts.some((item) => item.reason.toLowerCase().includes("oversized"))).toBe(
    true,
  );
  expect(resolved.loadedSkills).toHaveLength(0);
});

test("token-aware inclusion keeps mandatory and high-applicability bodies and omits the rest", () => {
  const discovery = discoverSkills({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [
      file(".pi/skills/must/SKILL.md", skillDoc("must-skill", "Must", "", "must-body")),
      file(
        ".pi/skills/hot/SKILL.md",
        skillDoc("hot-skill", "Hot", "scope: src", "hot-body"),
      ),
      file(".pi/skills/cold/SKILL.md", skillDoc("cold-skill", "Cold", "", "cold-body")),
    ],
  });
  const instructions = discoverContextFiles({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [file("AGENTS.md", "---\nmandatory-skills:\n  - must-skill\n---\nroot\n")],
  });
  const resolved = resolveSkills({
    snapshotId: SNAPSHOT_ID,
    discovery,
    instructionChain: effectiveChainForPath(buildScopeTrie(instructions, SNAPSHOT_ID), "src/a.ts"),
    touchedPaths: ["src/a.ts"],
    tokenBudget: 8,
    estimateTokens: (text) => (text.includes("cold-body") ? 100 : 1),
  });
  expect(resolved.loadedSkills.map((item) => item.skillId).sort()).toEqual(["hot-skill", "must-skill"]);
  expect(resolved.omittedSkillIds).toEqual(["cold-skill"]);
  expect(resolved.manifest.skills).toHaveLength(3);
});

test("untrusted instructions cannot force mandatory skill bodies", () => {
  const discovery = discoverSkills({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: false,
    nodes: [file(".pi/skills/must/SKILL.md", skillDoc("must-skill", "Must"))],
  });
  const instructions = discoverContextFiles({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: false,
    nodes: [file("AGENTS.md", "---\nmandatory-skills:\n  - must-skill\n---\nroot\n")],
  });
  const resolved = resolveSkills({
    snapshotId: SNAPSHOT_ID,
    discovery,
    instructionChain: effectiveChainForPath(buildScopeTrie(instructions, SNAPSHOT_ID), "a.ts"),
    touchedPaths: ["a.ts"],
    tokenBudget: 10_000,
  });
  expect(resolved.loadedSkills).toHaveLength(0);
  expect(resolved.omittedSkillIds).toEqual(["must-skill"]);
});

test("untrusted path-scoped skills stay descriptors without bodies", () => {
  const discovery = discoverSkills({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: false,
    nodes: [
      file(
        ".pi/skills/scoped/SKILL.md",
        skillDoc("path-skill", "Only for pkg", "scope: pkg"),
      ),
      file(".pi/skills/scoped/run.sh", "#!/bin/sh\necho pwn\n"),
    ],
  });
  expect(discovery.skills[0]?.trust).toBe("untrusted-data");
  expect(discovery.skills[0]?.descriptor.executableAssets.length).toBeGreaterThan(0);
  const resolved = resolveSkills({
    snapshotId: SNAPSHOT_ID,
    discovery,
    instructionChain: [],
    touchedPaths: ["pkg/src/a.ts"],
    tokenBudget: 10_000,
  });
  expect(resolved.loadedSkills).toHaveLength(0);
  expect(resolved.omittedSkillIds).toEqual(["path-skill"]);
  expect(resolved.manifest.skills).toHaveLength(1);
  expect(resolved.manifest.skills[0]?.id).toBe("path-skill");
  expect(resolved.manifest.skills[0]?.loadPolicy).toBe("on-request");
});

test("untrusted proven skills stay descriptors without bodies", () => {
  const discovery = discoverSkills({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: false,
    nodes: [file(".pi/skills/app/SKILL.md", skillDoc("app-skill", "Application"))],
  });
  const resolved = resolveSkills({
    snapshotId: SNAPSHOT_ID,
    discovery,
    instructionChain: [],
    touchedPaths: ["src/a.ts"],
    provenSkillIds: ["app-skill"],
    tokenBudget: 10_000,
  });
  expect(resolved.loadedSkills).toHaveLength(0);
  expect(resolved.omittedSkillIds).toEqual(["app-skill"]);
  expect(resolved.manifest.skills[0]?.loadPolicy).toBe("on-request");
});
