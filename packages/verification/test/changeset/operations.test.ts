import { expect, test } from "vitest";
import { taggedHash } from "@pi-hec/contracts";
import { candidateTreeDigest } from "@pi-hec/repository";
import { computeNormalizedChangeSetDigest } from "@pi-hec/domain";
import {
  SNAPSHOT_ID,
  ROOT,
  apply,
  baseline,
  changeSet,
  digestText,
  dirEntry,
  expectCode,
  fileEntry,
  sha256Hex,
  sha256Utf8,
} from "./helpers.js";
import { validateAndApplyChangeSet } from "../../src/index.js";

test("create_text writes a new UTF-8 file with expected after digest", () => {
  const content = "hello from create_text\n";
  const result = apply(
    [
      {
        kind: "create_text",
        path: "src/hello.txt",
        content,
        expectedAfterDigest: digestText(content),
        gitMode: "100644",
        expectedAbsent: true,
      },
    ],
    [dirEntry("src")],
  );
  const file = result.entries.find((entry) => entry.path === "src/hello.txt");
  expect(file?.entryType).toBe("file");
  if (file?.entryType !== "file") {
    throw new Error("expected file");
  }
  expect(Buffer.from(file.bytes).toString("utf8")).toBe(content);
  expect(file.gitMode).toBe("100644");
  expect(result.changedPaths).toEqual(["src/hello.txt"]);
});

test("create_directory requires an existing parent and expected absence", () => {
  const result = apply(
    [
      { kind: "create_directory", path: "src/pkg", expectedAbsent: true },
      {
        kind: "create_text",
        path: "src/pkg/mod.ts",
        content: "export {}\n",
        expectedAfterDigest: digestText("export {}\n"),
        gitMode: "100644",
        expectedAbsent: true,
      },
    ],
    [dirEntry("src")],
  );
  expect(result.entries.some((entry) => entry.path === "src/pkg" && entry.entryType === "directory")).toBe(
    true,
  );
});

test("create_text without an explicit parent directory is rejected", () => {
  expectCode(
    () =>
      apply([
        {
          kind: "create_text",
          path: "missing/parent.txt",
          content: "x",
          expectedAfterDigest: digestText("x"),
          gitMode: "100644",
          expectedAbsent: true,
        },
      ]),
    "PARENT_MISSING",
  );
});

test("write_binary creates and replaces exact bytes", () => {
  const created = Buffer.from([0, 1, 2, 255]);
  const replaced = Buffer.from([9, 8, 7]);
  const first = apply(
    [
      {
        kind: "write_binary",
        path: "assets/blob.bin",
        expectedBeforeDigest: null,
        mediaType: "application/octet-stream",
        base64Content: created.toString("base64"),
        expectedAfterDigest: sha256Hex(created),
        gitMode: "100644",
      },
    ],
    [dirEntry("assets")],
  );
  const blob = first.entries.find((entry) => entry.path === "assets/blob.bin");
  expect(blob?.entryType).toBe("file");
  const second = apply(
    [
      {
        kind: "write_binary",
        path: "assets/blob.bin",
        expectedBeforeDigest: sha256Hex(created),
        mediaType: "application/octet-stream",
        base64Content: replaced.toString("base64"),
        expectedAfterDigest: sha256Hex(replaced),
        gitMode: "100755",
      },
    ],
    [fileEntry("assets/blob.bin", created)],
  );
  const updated = second.entries.find((entry) => entry.path === "assets/blob.bin");
  expect(updated?.entryType).toBe("file");
  if (updated?.entryType !== "file") {
    throw new Error("expected file");
  }
  expect(Buffer.from(updated.bytes)).toEqual(replaced);
  expect(updated.gitMode).toBe("100755");
});

test("delete removes a file after verifying before digest", () => {
  const result = apply(
    [
      {
        kind: "delete",
        path: "src/gone.txt",
        expectedBeforeDigest: digestText("gone\n"),
      },
    ],
    [fileEntry("src/gone.txt", "gone\n")],
  );
  expect(result.entries.some((entry) => entry.path === "src/gone.txt")).toBe(false);
  expect(result.changedPaths).toEqual(["src/gone.txt"]);
});

test("delete_directory is bottom-up and checks directory-tree digest", () => {
  const emptyDigest = taggedHash("directory-tree", 1, { path: "tmp", entries: [] });
  expectCode(
    () =>
      apply(
        [
          {
            kind: "delete_directory",
            path: "tmp",
            expectedTreeDigest: emptyDigest,
            expectedEmptyAtOperation: true,
          },
        ],
        [fileEntry("tmp/keep.txt", "x")],
      ),
    "DIRECTORY_NOT_EMPTY",
  );
  const result = apply(
    [
      {
        kind: "delete",
        path: "tmp/keep.txt",
        expectedBeforeDigest: digestText("x"),
      },
      {
        kind: "delete_directory",
        path: "tmp",
        expectedTreeDigest: emptyDigest,
        expectedEmptyAtOperation: true,
      },
    ],
    [fileEntry("tmp/keep.txt", "x")],
  );
  expect(result.entries.some((entry) => entry.path === "tmp" || entry.path === "tmp/keep.txt")).toBe(false);
});

test("move relocates a file and forbids unstated overwrite", () => {
  const result = apply(
    [
      {
        kind: "move",
        from: "src/a.txt",
        to: "src/b.txt",
        expectedBeforeDigest: digestText("payload\n"),
        expectedDestinationDigest: null,
      },
    ],
    [fileEntry("src/a.txt", "payload\n")],
  );
  expect(result.entries.some((entry) => entry.path === "src/a.txt")).toBe(false);
  const dest = result.entries.find((entry) => entry.path === "src/b.txt");
  expect(dest?.entryType).toBe("file");
  expectCode(
    () =>
      apply(
        [
          {
            kind: "move",
            from: "src/a.txt",
            to: "src/b.txt",
            expectedBeforeDigest: digestText("payload\n"),
            expectedDestinationDigest: null,
          },
        ],
        [fileEntry("src/a.txt", "payload\n"), fileEntry("src/b.txt", "other\n")],
      ),
    "MOVE_OVERWRITE",
  );
});

test("move of a directory is rejected in revision 1", () => {
  expectCode(
    () =>
      apply(
        [
          {
            kind: "move",
            from: "src",
            to: "lib",
            expectedBeforeDigest: digestText("nope"),
            expectedDestinationDigest: null,
          },
        ],
        [dirEntry("src"), fileEntry("src/a.txt", "x")],
      ),
    "MOVE_DIRECTORY_FORBIDDEN",
  );
});

test("directory rename is dest dirs plus per-entry moves plus bottom-up delete", () => {
  const emptyA = taggedHash("directory-tree", 1, { path: "a", entries: [] });
  const result = apply(
    [
      { kind: "create_directory", path: "b", expectedAbsent: true },
      {
        kind: "move",
        from: "a/x.txt",
        to: "b/x.txt",
        expectedBeforeDigest: digestText("moved\n"),
        expectedDestinationDigest: null,
      },
      {
        kind: "delete_directory",
        path: "a",
        expectedTreeDigest: emptyA,
        expectedEmptyAtOperation: true,
      },
    ],
    [fileEntry("a/x.txt", "moved\n")],
  );
  expect(result.entries.some((entry) => entry.path === "a")).toBe(false);
  expect(result.entries.some((entry) => entry.path === "b/x.txt")).toBe(true);
});

test("set_git_mode toggles only 100644 ↔ 100755", () => {
  const result = apply(
    [
      {
        kind: "set_git_mode",
        path: "bin/run.sh",
        expectedBeforeDigest: digestText("#!/bin/sh\n"),
        expectedCurrentMode: "100644",
        newMode: "100755",
      },
    ],
    [fileEntry("bin/run.sh", "#!/bin/sh\n", "100644")],
  );
  const file = result.entries.find((entry) => entry.path === "bin/run.sh");
  expect(file?.entryType).toBe("file");
  if (file?.entryType !== "file") {
    throw new Error("expected file");
  }
  expect(file.gitMode).toBe("100755");
  expect(file.contentDigest).toBe(digestText("#!/bin/sh\n"));
});

test("symlink digest is SHA-256 of UTF-8 target bytes and stays contained", () => {
  const target = "hello.txt";
  const result = apply(
    [
      {
        kind: "symlink",
        path: "src/link",
        target,
        expectedBeforeDigest: null,
        expectedAfterDigest: sha256Utf8(target),
      },
    ],
    [dirEntry("src"), fileEntry("src/hello.txt", "hi\n")],
  );
  const link = result.entries.find((entry) => entry.path === "src/link");
  expect(link?.entryType).toBe("symlink");
  if (link?.entryType !== "symlink") {
    throw new Error("expected symlink");
  }
  expect(link.symlinkTarget).toBe(target);
  expect(link.contentDigest).toBe(sha256Utf8(target));
});

test("text_patch applies with exact hunk match and preserves untouched terminators", () => {
  const original = "alpha\r\nbeta\r\ngamma\r\n";
  const expected = "alpha\r\ndelta\ngamma\r\n";
  const result = apply(
    [
      {
        kind: "text_patch",
        path: "src/n.txt",
        expectedBeforeDigest: digestText(original),
        expectedAfterDigest: digestText(expected),
        unifiedDiff: ["--- a/src/n.txt", "+++ b/src/n.txt", "@@ -1,3 +1,3 @@", " alpha", "-beta", "+delta", " gamma"].join(
          "\n",
        ),
        insertedLineEnding: "LF",
        finalNewline: "PRESENT",
      },
    ],
    [fileEntry("src/n.txt", original)],
  );
  const file = result.entries.find((entry) => entry.path === "src/n.txt");
  expect(file?.entryType).toBe("file");
  if (file?.entryType !== "file") {
    throw new Error("expected file");
  }
  expect(Buffer.from(file.bytes).toString("utf8")).toBe(expected);
});

test("text_patch hunk body is parsed only by the first character", () => {
  const original = "SELECT 1;\n-- comment\nSELECT 2;\n";
  const expected = "SELECT 1;\n++ keep\nSELECT 2;\n";
  const result = apply(
    [
      {
        kind: "text_patch",
        path: "src/q.sql",
        expectedBeforeDigest: digestText(original),
        expectedAfterDigest: digestText(expected),
        unifiedDiff: [
          "--- a/src/q.sql",
          "+++ b/src/q.sql",
          "@@ -1,3 +1,3 @@",
          " SELECT 1;",
          "--- comment",
          "+++ keep",
          " SELECT 2;",
        ].join("\n"),
        insertedLineEnding: "LF",
        finalNewline: "PRESENT",
      },
    ],
    [fileEntry("src/q.sql", original)],
  );
  const file = result.entries.find((entry) => entry.path === "src/q.sql");
  expect(file?.entryType).toBe("file");
  if (file?.entryType !== "file") {
    throw new Error("expected file");
  }
  expect(Buffer.from(file.bytes).toString("utf8")).toBe(expected);
});

test("text_patch applies strictly increasing hunks on original coordinates", () => {
  const original = "a\nb\nc\n";
  const expected = "A\nb\nC\n";
  const result = apply(
    [
      {
        kind: "text_patch",
        path: "src/n.txt",
        expectedBeforeDigest: digestText(original),
        expectedAfterDigest: digestText(expected),
        unifiedDiff: [
          "--- a/src/n.txt",
          "+++ b/src/n.txt",
          "@@ -1,1 +1,1 @@",
          "-a",
          "+A",
          "@@ -3,1 +3,1 @@",
          "-c",
          "+C",
        ].join("\n"),
        insertedLineEnding: "LF",
        finalNewline: "PRESENT",
      },
    ],
    [fileEntry("src/n.txt", original)],
  );
  const file = result.entries.find((entry) => entry.path === "src/n.txt");
  expect(file?.entryType).toBe("file");
  if (file?.entryType !== "file") {
    throw new Error("expected file");
  }
  expect(Buffer.from(file.bytes).toString("utf8")).toBe(expected);
});

test("candidate root digest is reproducible and uses the candidate-tree domain", () => {
  const operations = [
    {
      kind: "create_text" as const,
      path: "src/hello.txt",
      content: "stable\n",
      expectedAfterDigest: digestText("stable\n"),
      gitMode: "100644" as const,
      expectedAbsent: true as const,
    },
  ];
  const first = apply(operations, [dirEntry("src")]);
  const second = apply(operations, [dirEntry("src")]);
  expect(first.materializedTreeDigest).toBe(second.materializedTreeDigest);
  expect(first.materializedTreeDigest).toBe(candidateTreeDigest(first.entries));
  expect(first.normalizedChangeSetDigest).toBe(
    computeNormalizedChangeSetDigest({
      baseSnapshotId: SNAPSHOT_ID,
      baseSnapshotRootDigest: ROOT,
      operations,
    }),
  );
  expect(first.materializedTreeDigest.startsWith("sha256:")).toBe(true);
});

test("AGENTS.md may appear in an explicit ChangeSet", () => {
  const result = apply(
    [
      {
        kind: "create_text",
        path: "AGENTS.md",
        content: "# next run only\n",
        expectedAfterDigest: digestText("# next run only\n"),
        gitMode: "100644",
        expectedAbsent: true,
      },
    ],
    [],
  );
  expect(result.changedPaths).toEqual(["AGENTS.md"]);
});

test("empty operations are rejected", () => {
  expectCode(
    () =>
      validateAndApplyChangeSet({
        changeSet: changeSet([]),
        baseline: baseline([]),
      }),
    "SCHEMA_INVALID",
  );
});
