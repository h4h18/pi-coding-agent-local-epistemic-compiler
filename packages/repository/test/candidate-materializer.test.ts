import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { sha256Hex, sha256Utf8 } from "@pi-hec/contracts";
import {
  CandidateMaterializeError,
  candidateTreeDigest,
  materializeCandidateTree,
  type CandidateEntry,
} from "../src/index.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function file(pathName: string, content: string, gitMode: "100644" | "100755" = "100644"): CandidateEntry {
  const bytes = new Uint8Array(Buffer.from(content, "utf8"));
  return {
    entryType: "file",
    path: pathName,
    gitMode,
    bytes,
    contentDigest: sha256Hex(bytes),
  };
}

test("materializeCandidateTree writes the declared tree and hashes candidate-tree", async () => {
  const dest = await tempDir("pi-hec-cand-");
  const entries: CandidateEntry[] = [
    { entryType: "directory", path: "src" },
    file("src/hello.txt", "hello-candidate\n"),
  ];
  const result = await materializeCandidateTree({ destRoot: dest, entries });
  expect(result.materializedTreeDigest).toBe(candidateTreeDigest(entries));
  expect(result.materializedTreeDigest).toBe(candidateTreeDigest([...entries].reverse()));
  expect(await readFile(path.join(dest, "src", "hello.txt"), "utf8")).toBe("hello-candidate\n");
  expect(result.writtenPaths.sort()).toEqual(["src", "src/hello.txt"]);
});

test("materializeCandidateTree refuses a non-empty destRoot", async () => {
  const dest = await tempDir("pi-hec-cand-full-");
  await materializeCandidateTree({
    destRoot: dest,
    entries: [file("once.txt", "x")],
  });
  await expect(
    materializeCandidateTree({
      destRoot: dest,
      entries: [file("twice.txt", "y")],
    }),
  ).rejects.toMatchObject({ name: "CandidateMaterializeError", code: "DEST_NOT_EMPTY" });
});

test("materializeCandidateTree rejects path escape and digest mismatch", async () => {
  const dest = await tempDir("pi-hec-cand-bad-");
  const bytes = new Uint8Array(Buffer.from("x", "utf8"));
  const bad: CandidateEntry = {
    entryType: "file",
    path: "ok.txt",
    gitMode: "100644",
    bytes,
    contentDigest: sha256Utf8("other"),
  };
  await expect(materializeCandidateTree({ destRoot: dest, entries: [bad] })).rejects.toBeInstanceOf(
    CandidateMaterializeError,
  );
});

test("materializeCandidateTree refuses .git protected and traversal paths", async () => {
  const dest = await tempDir("pi-hec-cand-prot-");
  const payload = file("ok.txt", "ok\n");
  await expect(
    materializeCandidateTree({
      destRoot: dest,
      entries: [file(".git/config", "[core]\n")],
    }),
  ).rejects.toMatchObject({ name: "CandidateMaterializeError", code: "PATH_PROTECTED" });
  await expect(
    materializeCandidateTree({
      destRoot: dest,
      entries: [file(".GIT/config", "[core]\n")],
    }),
  ).rejects.toMatchObject({ name: "CandidateMaterializeError", code: "PATH_PROTECTED" });
  await expect(
    materializeCandidateTree({
      destRoot: dest,
      entries: [file("src/.git/hooks", "#!/bin/sh\n")],
    }),
  ).rejects.toMatchObject({ name: "CandidateMaterializeError", code: "PATH_PROTECTED" });
  await expect(
    materializeCandidateTree({
      destRoot: dest,
      entries: [file("../secret.txt", "nope\n")],
    }),
  ).rejects.toMatchObject({ name: "CandidateMaterializeError", code: "PATH_TRAVERSAL" });
  await expect(
    materializeCandidateTree({
      destRoot: dest,
      entries: [file("notes.txt:secret", "ads\n")],
    }),
  ).rejects.toMatchObject({ name: "CandidateMaterializeError", code: "PATH_ADS" });
  expect(await readdir(dest)).toEqual([]);
  const written = await materializeCandidateTree({ destRoot: dest, entries: [payload] });
  expect(written.writtenPaths).toEqual(["ok.txt"]);
});

test("candidate-tree digest is independent of input order", () => {
  const left: CandidateEntry[] = [
    { entryType: "directory", path: "b" },
    { entryType: "directory", path: "a" },
    file("a/z.txt", "z"),
  ];
  const right = [...left].reverse();
  expect(candidateTreeDigest(left)).toBe(candidateTreeDigest(right));
});
