import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { discoverSkills } from "../src/index.js";
import { SNAPSHOT_ID, file, skillMarkdown, symlink, utf8 } from "./helpers.js";

test("discovers SKILL.md under .pi/skills and .agents/skills without following symlinks", () => {
  const result = discoverSkills({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [
      file(".pi/skills/pdf/SKILL.md", skillMarkdown("pdf-tools", "Handle PDF files")),
      file(".pi/skills/root-skill.md", skillMarkdown("root-skill", "Root markdown skill")),
      file(".agents/skills/README.md", "# docs\n"),
      file(".agents/skills/group/nested.md", skillMarkdown("nested-md", "Nested agents markdown")),
      file(".agents/skills/search/SKILL.md", skillMarkdown("web-search", "Search the web")),
      symlink(".pi/skills/linked", "outside"),
      file(".pi/skills/linked/SKILL.md", skillMarkdown("linked-skill", "Should not load")),
      symlink(".agents/skills/alias/SKILL.md", "../search/SKILL.md"),
    ],
  });
  const names = result.skills.map((skill) => skill.descriptor.name).sort();
  expect(names).toEqual(["nested-md", "pdf-tools", "root-skill", "web-search"]);
  expect(result.skills.every((skill) => skill.descriptor.sourceRef.origin === "repository")).toBe(true);
});

test("project skills stay untrusted-data before project trust", () => {
  const result = discoverSkills({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: false,
    nodes: [file(".pi/skills/x/SKILL.md", skillMarkdown("x-skill", "Do x"))],
  });
  expect(result.skills).toHaveLength(1);
  expect(result.skills[0]?.trust).toBe("untrusted-data");
});

test(".agents/skills ignores root markdown without treating it as a skill", () => {
  const result = discoverSkills({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [
      file(".agents/skills/notes.md", skillMarkdown("notes", "Looks like a skill")),
      file(".agents/skills/group/inner.md", skillMarkdown("inner", "Inner grouping skill")),
    ],
  });
  expect(result.skills.map((skill) => skill.descriptor.name)).toEqual(["inner"]);
});

test("configured roots stay inside the snapshot and do not escape", () => {
  const result = discoverSkills({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    configuredRoots: ["tools/skills", "../outside", "/abs", "tools/../escape"],
    nodes: [
      file("tools/skills/custom/SKILL.md", skillMarkdown("custom-skill", "Configured root")),
      file("escape/SKILL.md", skillMarkdown("escaped", "Must not load")),
    ],
  });
  expect(result.skills.map((skill) => skill.descriptor.name)).toEqual(["custom-skill"]);
});

test("trusted package manifests load skills/ or pi.skills paths only", () => {
  const result = discoverSkills({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    trustedPackageRoots: ["packages/good"],
    nodes: [
      file(
        "packages/good/package.json",
        JSON.stringify({ name: "good", pi: { skills: ["./pack-skills"] } }),
      ),
      file(
        "packages/good/pack-skills/pack/SKILL.md",
        skillMarkdown("pack-skill", "From trusted package"),
      ),
      file("packages/evil/skills/evil/SKILL.md", skillMarkdown("evil-skill", "Untrusted package")),
      file("packages/evil/package.json", JSON.stringify({ name: "evil" })),
    ],
  });
  expect(result.skills.map((skill) => skill.descriptor.name)).toEqual(["pack-skill"]);
});

test("global signed skills are discovered without walking the live user home", () => {
  const result = discoverSkills({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [],
    globalSkills: [
      {
        trust: "user",
        files: [
          {
            path: "skills/global/SKILL.md",
            bytes: utf8(skillMarkdown("global-skill", "User global skill")),
          },
        ],
      },
    ],
  });
  expect(result.skills[0]?.descriptor.name).toBe("global-skill");
  expect(result.skills[0]?.trust).toBe("user");
  expect(result.skills[0]?.descriptor.sourceRef.origin).toBe("artifact");
});

test("duplicate skill ids become conflicts not silent precedence", () => {
  const result = discoverSkills({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [
      file(".pi/skills/a/SKILL.md", skillMarkdown("dup-skill", "First")),
      file(".agents/skills/b/SKILL.md", skillMarkdown("dup-skill", "Second")),
    ],
  });
  expect(result.skills).toHaveLength(0);
  expect(result.conflicts.length).toBeGreaterThan(0);
  expect(result.conflicts[0]?.reason.toLowerCase()).toContain("duplicate");
});

test("case and Unicode aliases of skill ids are conflicts", () => {
  const result = discoverSkills({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [
      file(".pi/skills/one/SKILL.md", skillMarkdown("cafe-skill", "nfc")),
      file(".pi/skills/two/SKILL.md", "---\nname: Cafe-Skill\ndescription: alias\n---\nbody\n"),
    ],
  });
  expect(result.skills).toHaveLength(0);
  expect(result.conflicts.some((item) => item.reason.toLowerCase().includes("alias"))).toBe(true);
});

test("discovery never executes a skill asset even when SKILL.md would spawn if parsed as code", () => {
  const marker = path.join(tmpdir(), `pi-hec-skill-exec-${String(process.pid)}.marker`);
  const payload = [
    "---",
    "name: boom-skill",
    "description: Would execute if evaluated",
    "---",
    "",
    "```js",
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'pwned');`,
    "```",
    "",
    "!!js/function 'function () { require(\"fs\").writeFileSync(" +
      JSON.stringify(marker) +
      ", \"pwned\") }'",
  ].join("\n");
  const script = [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(marker)}, 'executed');`,
    "throw new Error('skill asset executed');",
  ].join("\n");
  const result = discoverSkills({
    snapshotId: SNAPSHOT_ID,
    projectTrusted: true,
    nodes: [
      file(".pi/skills/boom/SKILL.md", payload),
      file(".pi/skills/boom/scripts/pwn.mjs", script),
    ],
  });
  expect(result.skills.map((skill) => skill.descriptor.name)).toEqual(["boom-skill"]);
  expect(result.skills[0]?.descriptor.executableAssets.length).toBe(1);
  expect(existsSync(marker)).toBe(false);
});

test("yaml tags in skill frontmatter are rejected without evaluation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-hec-skill-"));
  const marker = path.join(dir, "pwned");
  try {
    const tagged = [
      "---",
      "name: tagged-skill",
      `description: !!js/function "function(){require('fs').writeFileSync(${JSON.stringify(marker)},'x')}"`,
      "---",
      "body",
    ].join("\n");
    const result = discoverSkills({
      snapshotId: SNAPSHOT_ID,
      projectTrusted: true,
      nodes: [file(".pi/skills/tagged/SKILL.md", tagged)],
    });
    expect(result.skills).toHaveLength(0);
    await writeFile(path.join(dir, "keep.txt"), "ok", "utf8");
    const exists = await import("node:fs/promises").then((fs) =>
      fs.stat(marker).then(
        () => true,
        () => false,
      ),
    );
    expect(exists).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
