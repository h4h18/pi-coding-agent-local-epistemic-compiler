import { expect, test } from "vitest";
import type { SnapshotEntry } from "@pi-hec/contracts";
import {
  apply,
  digestText,
  dirEntry,
  expectCode,
  fileEntry,
  sha256Hex,
  sha256Utf8,
  symlinkEntry,
} from "./helpers.js";

test("path traversal and absolute paths are rejected", () => {
  expectCode(
    () =>
      apply([
        {
          kind: "delete",
          path: "../secret",
          expectedBeforeDigest: digestText("x"),
        },
      ]),
    "SCHEMA_INVALID",
  );
  expectCode(
    () =>
      apply([
        {
          kind: "delete",
          path: "/etc/passwd",
          expectedBeforeDigest: digestText("x"),
        },
      ]),
    "SCHEMA_INVALID",
  );
});

test("device and drive-relative paths are rejected", () => {
  expectCode(
    () =>
      apply([
        {
          kind: "create_text",
          path: "C:foo",
          content: "x",
          expectedAfterDigest: digestText("x"),
          gitMode: "100644",
          expectedAbsent: true,
        },
      ]),
    "PATH_DEVICE",
  );
  expectCode(
    () =>
      apply([
        {
          kind: "create_text",
          path: "NUL",
          content: "x",
          expectedAfterDigest: digestText("x"),
          gitMode: "100644",
          expectedAbsent: true,
        },
      ]),
    "PATH_RESERVED",
  );
});

test("ADS colon paths are rejected", () => {
  expectCode(
    () =>
      apply([
        {
          kind: "create_text",
          path: "notes.txt:secret",
          content: "x",
          expectedAfterDigest: digestText("x"),
          gitMode: "100644",
          expectedAbsent: true,
        },
      ]),
    "PATH_ADS",
  );
});

test("protected .git paths never change", () => {
  expectCode(
    () =>
      apply([
        {
          kind: "create_text",
          path: ".git/config",
          content: "x",
          expectedAfterDigest: digestText("x"),
          gitMode: "100644",
          expectedAbsent: true,
        },
      ]),
    "PATH_PROTECTED",
  );
  expectCode(
    () =>
      apply(
        [
          {
            kind: "delete",
            path: ".git/hooks/pre-commit",
            expectedBeforeDigest: digestText("#!/bin/sh\n"),
          },
        ],
        [fileEntry(".git/hooks/pre-commit", "#!/bin/sh\n")],
      ),
    "PATH_PROTECTED",
  );
});

test("before digest mismatch rejects the whole candidate", () => {
  expectCode(
    () =>
      apply(
        [
          {
            kind: "delete",
            path: "src/a.txt",
            expectedBeforeDigest: digestText("wrong"),
          },
        ],
        [fileEntry("src/a.txt", "right\n")],
      ),
    "DIGEST_BEFORE_MISMATCH",
  );
});

test("after digest mismatch rejects the whole candidate", () => {
  expectCode(
    () =>
      apply(
        [
          {
            kind: "create_text",
            path: "src/a.txt",
            content: "hello\n",
            expectedAfterDigest: digestText("other\n"),
            gitMode: "100644",
            expectedAbsent: true,
          },
        ],
        [dirEntry("src")],
      ),
    "DIGEST_AFTER_MISMATCH",
  );
});

test("strict hunk matching rejects fuzzy/offset context", () => {
  const original = "one\ntwo\nthree\n";
  expectCode(
    () =>
      apply(
        [
          {
            kind: "text_patch",
            path: "src/n.txt",
            expectedBeforeDigest: digestText(original),
            expectedAfterDigest: digestText("one\nTWO\nthree\n"),
            unifiedDiff: [
              "--- a/src/n.txt",
              "+++ b/src/n.txt",
              "@@ -1,1 +1,1 @@",
              "-two",
              "+TWO",
            ].join("\n"),
            insertedLineEnding: "LF",
            finalNewline: "PRESENT",
          },
        ],
        [fileEntry("src/n.txt", original)],
      ),
    "TEXT_PATCH_HUNK",
  );
});

test("strict hunk matching rejects fuzzy/offset context", () => {
  const original = "one\ntwo\nthree\n";
  expectCode(
    () =>
      apply(
        [
          {
            kind: "text_patch",
            path: "src/n.txt",
            expectedBeforeDigest: digestText(original),
            expectedAfterDigest: digestText("one\nTWO\nthree\n"),
            unifiedDiff: [
              "--- a/src/n.txt",
              "+++ b/src/n.txt",
              "@@ -1,1 +1,1 @@",
              "-two",
              "+TWO",
            ].join("\n"),
            insertedLineEnding: "LF",
            finalNewline: "PRESENT",
          },
        ],
        [fileEntry("src/n.txt", original)],
      ),
    "TEXT_PATCH_HUNK",
  );
});

test("later hunks cannot match context at a shifted offset", () => {
  const original = "target\nother\ntarget\n";
  expectCode(
    () =>
      apply(
        [
          {
            kind: "text_patch",
            path: "src/n.txt",
            expectedBeforeDigest: digestText(original),
            expectedAfterDigest: digestText("other\nTARGET\n"),
            unifiedDiff: [
              "--- a/src/n.txt",
              "+++ b/src/n.txt",
              "@@ -1,1 +1,0 @@",
              "-target",
              "@@ -2,1 +1,1 @@",
              "-target",
              "+TARGET",
            ].join("\n"),
            insertedLineEnding: "LF",
            finalNewline: "PRESENT",
          },
        ],
        [fileEntry("src/n.txt", original)],
      ),
    "TEXT_PATCH_HUNK",
  );
});

test("out-of-order and overlapping hunks are rejected", () => {
  const original = "a\nb\nc\n";
  expectCode(
    () =>
      apply(
        [
          {
            kind: "text_patch",
            path: "src/n.txt",
            expectedBeforeDigest: digestText(original),
            expectedAfterDigest: digestText("A\nb\nC\n"),
            unifiedDiff: [
              "--- a/src/n.txt",
              "+++ b/src/n.txt",
              "@@ -3,1 +3,1 @@",
              "-c",
              "+C",
              "@@ -1,1 +1,1 @@",
              "-a",
              "+A",
            ].join("\n"),
            insertedLineEnding: "LF",
            finalNewline: "PRESENT",
          },
        ],
        [fileEntry("src/n.txt", original)],
      ),
    "TEXT_PATCH_HUNK",
  );
  expectCode(
    () =>
      apply(
        [
          {
            kind: "text_patch",
            path: "src/n.txt",
            expectedBeforeDigest: digestText(original),
            expectedAfterDigest: digestText("a\nB\nc\n"),
            unifiedDiff: [
              "--- a/src/n.txt",
              "+++ b/src/n.txt",
              "@@ -1,3 +1,3 @@",
              " a",
              "-b",
              "+B",
              " c",
              "@@ -2,1 +2,1 @@",
              "-b",
              "+B",
            ].join("\n"),
            insertedLineEnding: "LF",
            finalNewline: "PRESENT",
          },
        ],
        [fileEntry("src/n.txt", original)],
      ),
    "TEXT_PATCH_HUNK",
  );
});

test("@@ -0,0 is invalid on a non-empty file and valid as a pure empty insert", () => {
  expectCode(
    () =>
      apply(
        [
          {
            kind: "text_patch",
            path: "src/n.txt",
            expectedBeforeDigest: digestText("keep\n"),
            expectedAfterDigest: digestText("new\nkeep\n"),
            unifiedDiff: ["--- a/src/n.txt", "+++ b/src/n.txt", "@@ -0,0 +1,1 @@", "+new"].join(
              "\n",
            ),
            insertedLineEnding: "LF",
            finalNewline: "PRESENT",
          },
        ],
        [fileEntry("src/n.txt", "keep\n")],
      ),
    "TEXT_PATCH_HUNK",
  );
  const result = apply(
    [
      {
        kind: "text_patch",
        path: "src/empty.txt",
        expectedBeforeDigest: digestText(""),
        expectedAfterDigest: digestText("hello\n"),
        unifiedDiff: [
          "--- a/src/empty.txt",
          "+++ b/src/empty.txt",
          "@@ -0,0 +1,1 @@",
          "+hello",
        ].join("\n"),
        insertedLineEnding: "LF",
        finalNewline: "PRESENT",
      },
    ],
    [fileEntry("src/empty.txt", "")],
  );
  const file = result.entries.find((entry) => entry.path === "src/empty.txt");
  expect(file?.entryType).toBe("file");
  if (file?.entryType !== "file") {
    throw new Error("expected file");
  }
  expect(Buffer.from(file.bytes).toString("utf8")).toBe("hello\n");
});

test("text_patch file headers for another path are forbidden", () => {
  expectCode(
    () =>
      apply(
        [
          {
            kind: "text_patch",
            path: "src/a.txt",
            expectedBeforeDigest: digestText("a\n"),
            expectedAfterDigest: digestText("b\n"),
            unifiedDiff: ["--- a/src/b.txt", "+++ b/src/b.txt", "@@ -1,1 +1,1 @@", "-a", "+b"].join(
              "\n",
            ),
            insertedLineEnding: "LF",
            finalNewline: "PRESENT",
          },
        ],
        [fileEntry("src/a.txt", "a\n")],
      ),
    "TEXT_PATCH_HEADER",
  );
});

test("symlink escape and symlink alias are rejected", () => {
  expectCode(
    () =>
      apply(
        [
          {
            kind: "symlink",
            path: "src/link",
            target: "../../outside",
            expectedBeforeDigest: null,
            expectedAfterDigest: sha256Utf8("../../outside"),
          },
        ],
        [dirEntry("src")],
      ),
    "SYMLINK_ESCAPE",
  );
  expectCode(
    () =>
      apply(
        [
          {
            kind: "create_text",
            path: "src/link/nested.txt",
            content: "x",
            expectedAfterDigest: digestText("x"),
            gitMode: "100644",
            expectedAbsent: true,
          },
        ],
        [
          dirEntry("src"),
          symlinkEntry("src/link", "hello.txt"),
          fileEntry("src/hello.txt", "hi\n"),
        ],
      ),
    "SYMLINK_ALIAS",
  );
});

test("case collision on a case-insensitive tree is rejected", () => {
  expectCode(
    () =>
      apply(
        [
          {
            kind: "create_text",
            path: "src/Readme",
            content: "x",
            expectedAfterDigest: digestText("x"),
            gitMode: "100644",
            expectedAbsent: true,
          },
        ],
        [fileEntry("src/README", "old\n")],
      ),
    "ALIAS_AMBIGUOUS",
  );
});

test("case-fold uses NFC and toUpperCase so Turkish ı collides with I", () => {
  expectCode(
    () =>
      apply(
        [
          {
            kind: "create_text",
            path: "src/I.txt",
            content: "x",
            expectedAfterDigest: digestText("x"),
            gitMode: "100644",
            expectedAbsent: true,
          },
        ],
        [fileEntry("src/ı.txt", "old\n")],
      ),
    "ALIAS_AMBIGUOUS",
  );
  const dotted = apply(
    [
      {
        kind: "create_text",
        path: "src/İ.txt",
        content: "x",
        expectedAfterDigest: digestText("x"),
        gitMode: "100644",
        expectedAbsent: true,
      },
    ],
    [fileEntry("src/i.txt", "old\n")],
  );
  expect(dotted.entries.some((entry) => entry.path === "src/i.txt")).toBe(true);
  expect(dotted.entries.some((entry) => entry.path === "src/İ.txt")).toBe(true);
});

test("case-only rename uses an internal temporary name that is not a ChangeOperation", () => {
  const result = apply(
    [
      {
        kind: "move",
        from: "src/Readme.txt",
        to: "src/readme.txt",
        expectedBeforeDigest: digestText("same\n"),
        expectedDestinationDigest: null,
      },
    ],
    [fileEntry("src/Readme.txt", "same\n")],
  );
  expect(result.entries.some((entry) => entry.path === "src/Readme.txt")).toBe(false);
  expect(result.entries.some((entry) => entry.path === "src/readme.txt")).toBe(true);
  expect(result.entries.some((entry) => entry.path.startsWith(".pi-hec-case-tmp-"))).toBe(false);
});

test("hardlink identities in the resulting tree are rejected", () => {
  const meta = (fileId: string): SnapshotEntry["platformMetadata"] => ({
    kind: "windows",
    fileId,
    securityDescriptorDigest: sha256Utf8("sd"),
    alternateStreams: [],
  });
  const left = { ...fileEntry("src/a.txt", "shared\n"), platformMetadata: meta("id-1") };
  const right = { ...fileEntry("src/b.txt", "shared\n"), platformMetadata: meta("id-1") };
  expectCode(
    () =>
      apply(
        [
          {
            kind: "set_git_mode",
            path: "src/a.txt",
            expectedBeforeDigest: digestText("shared\n"),
            expectedCurrentMode: "100644",
            newMode: "100755",
          },
        ],
        [left, right],
      ),
    "HARDLINK",
  );
});

test("canonical chains allow move → text_patch → set_git_mode", () => {
  const original = "old\n";
  const patched = "new\n";
  const result = apply(
    [
      {
        kind: "move",
        from: "src/old.txt",
        to: "src/new.txt",
        expectedBeforeDigest: digestText(original),
        expectedDestinationDigest: null,
      },
      {
        kind: "text_patch",
        path: "src/new.txt",
        expectedBeforeDigest: digestText(original),
        expectedAfterDigest: digestText(patched),
        unifiedDiff: [
          "--- a/src/new.txt",
          "+++ b/src/new.txt",
          "@@ -1,1 +1,1 @@",
          "-old",
          "+new",
        ].join("\n"),
        insertedLineEnding: "LF",
        finalNewline: "PRESENT",
      },
      {
        kind: "set_git_mode",
        path: "src/new.txt",
        expectedBeforeDigest: digestText(patched),
        expectedCurrentMode: "100644",
        newMode: "100755",
      },
    ],
    [fileEntry("src/old.txt", original)],
  );
  const file = result.entries.find((entry) => entry.path === "src/new.txt");
  expect(file?.entryType).toBe("file");
  if (file?.entryType !== "file") {
    throw new Error("expected file");
  }
  expect(Buffer.from(file.bytes).toString("utf8")).toBe(patched);
  expect(file.gitMode).toBe("100755");
});

test("two text_patch operations on one path are ambiguous", () => {
  expectCode(
    () =>
      apply(
        [
          {
            kind: "text_patch",
            path: "src/n.txt",
            expectedBeforeDigest: digestText("a\n"),
            expectedAfterDigest: digestText("b\n"),
            unifiedDiff: ["--- a/src/n.txt", "+++ b/src/n.txt", "@@ -1,1 +1,1 @@", "-a", "+b"].join(
              "\n",
            ),
            insertedLineEnding: "LF",
            finalNewline: "PRESENT",
          },
          {
            kind: "text_patch",
            path: "src/n.txt",
            expectedBeforeDigest: digestText("b\n"),
            expectedAfterDigest: digestText("c\n"),
            unifiedDiff: ["--- a/src/n.txt", "+++ b/src/n.txt", "@@ -1,1 +1,1 @@", "-b", "+c"].join(
              "\n",
            ),
            insertedLineEnding: "LF",
            finalNewline: "PRESENT",
          },
        ],
        [fileEntry("src/n.txt", "a\n")],
      ),
    "CHAIN_AMBIGUOUS",
  );
});

test("text_patch preserves UTF-8 BOM and rejects NUL/binary encodings", () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const original = Buffer.concat([bom, Buffer.from("hi\n", "utf8")]);
  const expected = Buffer.concat([bom, Buffer.from("ho\n", "utf8")]);
  const result = apply(
    [
      {
        kind: "text_patch",
        path: "src/bom.txt",
        expectedBeforeDigest: sha256Hex(original),
        expectedAfterDigest: sha256Hex(expected),
        unifiedDiff: [
          "--- a/src/bom.txt",
          "+++ b/src/bom.txt",
          "@@ -1,1 +1,1 @@",
          "-hi",
          "+ho",
        ].join("\n"),
        insertedLineEnding: "LF",
        finalNewline: "PRESENT",
      },
    ],
    [fileEntry("src/bom.txt", original)],
  );
  const file = result.entries.find((entry) => entry.path === "src/bom.txt");
  expect(file?.entryType).toBe("file");
  if (file?.entryType !== "file") {
    throw new Error("expected file");
  }
  expect(Buffer.from(file.bytes)).toEqual(expected);
  expectCode(
    () =>
      apply(
        [
          {
            kind: "text_patch",
            path: "src/zero.bin",
            expectedBeforeDigest: sha256Hex(Buffer.from([1, 0, 2])),
            expectedAfterDigest: sha256Hex(Buffer.from([1, 0, 3])),
            unifiedDiff: [
              "--- a/src/zero.bin",
              "+++ b/src/zero.bin",
              "@@ -1,1 +1,1 @@",
              "-x",
              "+y",
            ].join("\n"),
            insertedLineEnding: "LF",
            finalNewline: "PRESENT",
          },
        ],
        [fileEntry("src/zero.bin", Buffer.from([1, 0, 2]))],
      ),
    "TEXT_PATCH_ENCODING",
  );
});

test("null expectedBeforeDigest requires the path to be absent", () => {
  expectCode(
    () =>
      apply(
        [
          {
            kind: "write_binary",
            path: "src/a.bin",
            expectedBeforeDigest: null,
            mediaType: "application/octet-stream",
            base64Content: Buffer.from("x").toString("base64"),
            expectedAfterDigest: digestText("x"),
            gitMode: "100644",
          },
        ],
        [fileEntry("src/a.bin", "old")],
      ),
    "PATH_MUST_BE_ABSENT",
  );
});

test("move replace is allowed only for the exact destination digest", () => {
  const result = apply(
    [
      {
        kind: "move",
        from: "src/a.txt",
        to: "src/b.txt",
        expectedBeforeDigest: digestText("new\n"),
        expectedDestinationDigest: digestText("old\n"),
      },
    ],
    [fileEntry("src/a.txt", "new\n"), fileEntry("src/b.txt", "old\n")],
  );
  const dest = result.entries.find((entry) => entry.path === "src/b.txt");
  expect(dest?.entryType).toBe("file");
  if (dest?.entryType !== "file") {
    throw new Error("expected file");
  }
  expect(Buffer.from(dest.bytes).toString("utf8")).toBe("new\n");
  expectCode(
    () =>
      apply(
        [
          {
            kind: "move",
            from: "src/a.txt",
            to: "src/b.txt",
            expectedBeforeDigest: digestText("new\n"),
            expectedDestinationDigest: digestText("wrong\n"),
          },
        ],
        [fileEntry("src/a.txt", "new\n"), fileEntry("src/b.txt", "old\n")],
      ),
    "DIGEST_BEFORE_MISMATCH",
  );
});
