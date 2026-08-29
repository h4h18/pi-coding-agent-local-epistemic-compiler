import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { taggedHash, type GitHistoryManifest } from "@pi-hec/contracts";
import { rebuildSnapshotIndex } from "@pi-hec/repository";
import {
  collectDeltas,
  createRetrievalChannels,
  retrieveAndFuse,
  openIndexDatabase,
} from "../src/claims.js";
import { createRetrievalAction } from "../src/frontier.js";
import {
  applyEvidenceDelta,
  assertEvidenceGraph,
  evidenceGraphDigest,
  isHistoricalNode,
} from "../src/graph.js";
import { overloadKeyFor } from "../src/dedupe.js";
import {
  PROJECT,
  RUN_ID,
  SNAPSHOT_ID,
  TS,
  claimId,
  cleanupTempDirs,
  digestOf,
  dirEntry,
  fileEntry,
  gitHistory,
  memoryBlobs,
  snapshotOf,
  tempDir,
  utf8,
} from "./helpers.js";

afterEach(async () => {
  await cleanupTempDirs();
});

async function indexed(input: {
  files: { path: string; text: string }[];
  gitHistory?: GitHistoryManifest;
}): Promise<{ db: ReturnType<typeof openIndexDatabase>; dbPath: string }> {
  const blobs = memoryBlobs();
  const entries = [
    dirEntry("src"),
    ...input.files.map((file) => fileEntry(file.path, utf8(file.text), blobs)),
  ];
  const dir = await tempDir("pi-hec-evidence-fuse-");
  const dbPath = path.join(dir, "index.db");
  await rebuildSnapshotIndex({
    dbPath,
    projectId: PROJECT,
    manifest: snapshotOf(entries),
    getBlob: blobs.getBlob,
    gitHistory: input.gitHistory ?? gitHistory(input.files.map((file) => file.path)),
  });
  return { db: openIndexDatabase(dbPath), dbPath };
}

test("retrieveAndFuse blob dedupe does not fake independence across producers", async () => {
  const body = "// blobTwin marker\nexport function blobTwin() { return 101; }\n";
  const { db } = await indexed({
    files: [
      { path: "src/blob-a.ts", text: body },
      { path: "src/blob-b.ts", text: body },
    ],
  });
  try {
    const host = { snapshotId: SNAPSHOT_ID, db, nowIso: () => TS, runId: RUN_ID };
    const sameProducer = await retrieveAndFuse(
      host,
      {
        runId: RUN_ID,
        snapshotId: SNAPSHOT_ID,
        claimIds: [claimId("blob")],
        entityHints: ["blobTwin"],
        relationHints: [],
      },
      new AbortController().signal,
    );
    const sameSymbols = sameProducer.graph.nodes.filter(
      (node) => node.kind === "symbol" && node.identityKey.includes("blobTwin"),
    );
    expect(sameSymbols).toHaveLength(1);
    expect(sameSymbols[0]?.provenance.length).toBeGreaterThan(1);
    db.prepare("UPDATE units SET producer = 'other-chunker/v1' WHERE path = 'src/blob-b.ts' AND symbol_id = 'blobTwin'").run();
    const split = await retrieveAndFuse(
      host,
      {
        runId: RUN_ID,
        snapshotId: SNAPSHOT_ID,
        claimIds: [claimId("blob-split")],
        entityHints: ["blobTwin"],
        relationHints: [],
      },
      new AbortController().signal,
    );
    const splitSymbols = split.graph.nodes.filter(
      (node) => node.kind === "symbol" && node.identityKey.includes("blobTwin"),
    );
    expect(splitSymbols).toHaveLength(2);
    expect(new Set(splitSymbols.map((node) => node.trust.independenceGroup)).size).toBe(2);
    expect(
      split.subjects
        .filter((subject) => subject.scipSymbolId === "blobTwin")
        .every((subject) => subject.fqSignature !== subject.astFingerprint),
    ).toBe(true);
  } finally {
    db.close();
  }
});

test("retrieveAndFuse SCIP/FQ merge, AST merge, and interval merge", async () => {
  const { db } = await indexed({
    files: [
      { path: "src/scip-a.ts", text: "export function scipShared() { return 1; }\n" },
      { path: "src/scip-b.ts", text: "export function scipShared() { return 2; }\n" },
      { path: "src/ast-a.ts", text: "export function astTwin() { return 42; }\n" },
      { path: "src/ast-b.ts", text: "export function astTwin() { return  42; }\n" },
      {
        path: "src/interval.ts",
        text: "export class IntervalHost {\n  intervalMethod() { return 3; }\n}\n",
      },
    ],
  });
  try {
    db.prepare(
      `UPDATE units SET symbol_id = '', interface_fingerprint = '' WHERE path IN ('src/ast-a.ts', 'src/ast-b.ts') AND kind = 'function'`,
    ).run();
    db.prepare(
      `UPDATE units SET symbol_id = '', interface_fingerprint = '' WHERE path = 'src/interval.ts' AND kind IN ('class', 'method')`,
    ).run();
    const host = { snapshotId: SNAPSHOT_ID, db, nowIso: () => TS, runId: RUN_ID };
    const scip = await retrieveAndFuse(
      host,
      {
        runId: RUN_ID,
        snapshotId: SNAPSHOT_ID,
        claimIds: [claimId("scip")],
        entityHints: ["scipShared"],
        relationHints: [],
      },
      new AbortController().signal,
    );
    expect(
      scip.graph.nodes.filter((node) => node.kind === "symbol" && node.identityKey.includes("scipShared")),
    ).toHaveLength(1);

    const ast = await retrieveAndFuse(
      host,
      {
        runId: RUN_ID,
        snapshotId: SNAPSHOT_ID,
        claimIds: [claimId("ast")],
        entityHints: ["astTwin"],
        relationHints: [],
      },
      new AbortController().signal,
    );
    const astSymbols = ast.graph.nodes.filter(
      (node) =>
        node.kind === "symbol" && (node.identityKey.includes("ast-a") || node.identityKey.includes("ast-b")),
    );
    expect(astSymbols).toHaveLength(1);
    assertEvidenceGraph(ast.graph);
    const astIds = new Set(ast.graph.nodes.map((node) => node.id));
    expect(ast.graph.edges.every((edge) => astIds.has(edge.from) && astIds.has(edge.to))).toBe(true);

    const interval = await retrieveAndFuse(
      host,
      {
        runId: RUN_ID,
        snapshotId: SNAPSHOT_ID,
        claimIds: [claimId("interval")],
        entityHints: ["IntervalHost"],
        relationHints: [],
      },
      new AbortController().signal,
    );
    expect(
      interval.graph.nodes.filter((node) => node.kind === "symbol" && node.identityKey.includes("interval.ts")),
    ).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("retrieveAndFuse near-clone merges same-dir whitespace clones when AST and SCIP do not", async () => {
  const { db } = await indexed({
    files: [
      { path: "src/near-a.ts", text: "export function ping() { return 1; }\n" },
      { path: "src/near-b.ts", text: "export function ping() { return  1; }\n" },
    ],
  });
  try {
    db.prepare(
      `UPDATE units SET symbol_id = '', interface_fingerprint = '', parent_hierarchy = ? WHERE path = 'src/near-b.ts' AND kind = 'function'`,
    ).run(JSON.stringify(["src/near-b.ts", "HostB"]));
    db.prepare(
      `UPDATE units SET symbol_id = '', interface_fingerprint = '', parent_hierarchy = ? WHERE path = 'src/near-a.ts' AND kind = 'function'`,
    ).run(JSON.stringify(["src/near-a.ts", "HostA"]));
    const host = { snapshotId: SNAPSHOT_ID, db, nowIso: () => TS, runId: RUN_ID };
    const near = await retrieveAndFuse(
      host,
      {
        runId: RUN_ID,
        snapshotId: SNAPSHOT_ID,
        claimIds: [claimId("near")],
        entityHints: ["ping"],
        relationHints: [],
      },
      new AbortController().signal,
    );
    const functions = near.graph.nodes.filter(
      (node) =>
        node.kind === "symbol" && (node.identityKey.includes("near-a") || node.identityKey.includes("near-b")),
    );
    expect(functions.length).toBeGreaterThanOrEqual(1);
    const cloneSubjects = near.subjects.filter(
      (subject) => subject.path.startsWith("src/near-") && subject.node.kind === "symbol",
    );
    expect(cloneSubjects).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("retrieveAndFuse keeps overloads with similar text as distinct nodes", async () => {
  const { db } = await indexed({
    files: [
      { path: "src/over-a.ts", text: "export function add(x) { return x; }\n" },
      { path: "src/over-b.ts", text: "export function add(x) { return  x; }\n" },
    ],
  });
  try {
    db.prepare(
      `UPDATE units SET interface_fingerprint = 'add(number)' WHERE path = 'src/over-a.ts' AND kind = 'function'`,
    ).run();
    db.prepare(
      `UPDATE units SET interface_fingerprint = 'add(string)' WHERE path = 'src/over-b.ts' AND kind = 'function'`,
    ).run();
    const host = { snapshotId: SNAPSHOT_ID, db, nowIso: () => TS, runId: RUN_ID };
    const fused = await retrieveAndFuse(
      host,
      {
        runId: RUN_ID,
        snapshotId: SNAPSHOT_ID,
        claimIds: [claimId("overloads")],
        entityHints: ["add"],
        relationHints: [],
      },
      new AbortController().signal,
    );
    const overloadSubjects = fused.subjects.filter(
      (subject) => subject.node.kind === "symbol" && subject.path.startsWith("src/over-") && subject.scipSymbolId === "add",
    );
    expect(overloadSubjects).toHaveLength(2);
    expect(new Set(overloadSubjects.map((subject) => subject.overloadKey))).toEqual(
      new Set([overloadKeyFor("add", "add(number)"), overloadKeyFor("add", "add(string)")]),
    );
    expect(
      fused.graph.nodes.filter((node) => node.kind === "symbol" && node.identityKey.includes(":add")),
    ).toHaveLength(2);
  } finally {
    db.close();
  }
});

test("retrieveAndFuse does not merge different git revisions", async () => {
  const blobs = memoryBlobs();
  const patchA = blobs.put(utf8("diff --git a/x b/x\n+revTokenA\n"));
  const patchB = blobs.put(utf8("diff --git a/x b/x\n+revTokenA \n"));
  const commits: GitHistoryManifest["commits"] = [
    {
      objectId: "aaa111bbb222ccc333",
      parentObjectIds: [],
      authorTimestamp: TS,
      committerTimestamp: TS,
      messageDigest: digestOf("commit-a"),
      changedPaths: ["src/rev.ts"],
      patchArtifactObjectDigest: patchA,
    },
    {
      objectId: "ddd444eee555fff666",
      parentObjectIds: ["aaa111bbb222ccc333"],
      authorTimestamp: TS,
      committerTimestamp: TS,
      messageDigest: digestOf("commit-b"),
      changedPaths: ["src/rev.ts"],
      patchArtifactObjectDigest: patchB,
    },
  ];
  const historyRootDigest = taggedHash("git-history-root", 1, {
    repositoryId: "repo-evidence",
    refs: [{ name: "HEAD", targetObjectId: "ddd444eee555fff666" }],
    commits: structuredClone(commits),
    shallowBoundaryObjectIds: [],
    replaceRefsIgnored: true,
  });
  const history: GitHistoryManifest = {
    schemaVersion: 1,
    repositoryId: "repo-evidence",
    snapshotId: SNAPSHOT_ID,
    historyRootDigest,
    refs: [{ name: "HEAD", targetObjectId: "ddd444eee555fff666" }],
    commits,
    shallowBoundaryObjectIds: [],
    replaceRefsIgnored: true,
  };
  const entries = [
    dirEntry("src"),
    fileEntry("src/rev.ts", utf8("export const revTokenA = 1;\n"), blobs),
  ];
  const dir = await tempDir("pi-hec-evidence-rev-");
  const dbPath = path.join(dir, "index.db");
  await rebuildSnapshotIndex({
    dbPath,
    projectId: PROJECT,
    manifest: snapshotOf(entries),
    getBlob: blobs.getBlob,
    gitHistory: history,
  });
  const db = openIndexDatabase(dbPath);
  try {
    const result = await retrieveAndFuse(
      { snapshotId: SNAPSHOT_ID, db, nowIso: () => TS, runId: RUN_ID },
      {
        runId: RUN_ID,
        snapshotId: SNAPSHOT_ID,
        claimIds: [claimId("rev")],
        entityHints: ["revTokenA"],
        relationHints: [],
      },
      new AbortController().signal,
    );
    const historical = result.graph.nodes.filter((node) => isHistoricalNode(node));
    expect(historical.length).toBeGreaterThanOrEqual(2);
    expect(new Set(historical.map((node) => node.id)).size).toBe(historical.length);
  } finally {
    db.close();
  }
});

test("git-history seed filters by intent and does not dump the full history", async () => {
  const { db } = await indexed({
    files: [{ path: "src/math.ts", text: "export function add(a: number, b: number) { return a + b; }\n" }],
    gitHistory: gitHistory(["src/math.ts"]),
  });
  try {
    const host = { snapshotId: SNAPSHOT_ID, db, nowIso: () => TS, runId: RUN_ID };
    const git = createRetrievalChannels(host).find((channel) => channel.id === "git-history");
    if (git === undefined) {
      throw new Error("missing git-history channel");
    }
    const miss = await collectDeltas(
      git.seed(
        {
          runId: RUN_ID,
          snapshotId: SNAPSHOT_ID,
          claimIds: [claimId("miss")],
          entityHints: ["zzznomatchtoken999"],
          relationHints: [],
        },
        new AbortController().signal,
      ),
    );
    expect(miss.flatMap((delta) => delta.nodes).filter((node) => isHistoricalNode(node))).toHaveLength(0);
    const hit = await collectDeltas(
      git.seed(
        {
          runId: RUN_ID,
          snapshotId: SNAPSHOT_ID,
          claimIds: [claimId("hit")],
          entityHints: ["math"],
          relationHints: [],
        },
        new AbortController().signal,
      ),
    );
    expect(hit.flatMap((delta) => delta.nodes).some((node) => isHistoricalNode(node))).toBe(true);
  } finally {
    db.close();
  }
});

test("expand on a non-empty graph applies with that graph as the delta base", async () => {
  const { db } = await indexed({
    files: [{ path: "src/math.ts", text: "export function add(a: number, b: number) { return a + b; }\n" }],
  });
  try {
    const host = { snapshotId: SNAPSHOT_ID, db, nowIso: () => TS, runId: RUN_ID };
    const seeded = await retrieveAndFuse(
      host,
      {
        runId: RUN_ID,
        snapshotId: SNAPSHOT_ID,
        claimIds: [claimId("seed")],
        entityHints: ["add"],
        relationHints: [],
      },
      new AbortController().signal,
    );
    expect(seeded.graph.nodes.length).toBeGreaterThan(0);
    const expanding = { ...host, graph: seeded.graph };
    const bm25 = createRetrievalChannels(expanding).find((channel) => channel.id === "bm25");
    if (bm25 === undefined) {
      throw new Error("missing bm25 channel");
    }
    const deltas = await collectDeltas(
      bm25.expand(
        createRetrievalAction({
          id: "expand-1",
          channelId: "bm25",
          targetClaimIds: [claimId("seed")],
          query: "add",
        }),
        new AbortController().signal,
      ),
    );
    const delta = deltas[0];
    if (delta === undefined) {
      throw new Error("missing expand delta");
    }
    expect(delta.baseEvidenceGraphObjectDigest).toBe(evidenceGraphDigest(seeded.graph));
    const applied = applyEvidenceDelta(seeded.graph, delta);
    assertEvidenceGraph(applied);
    expect(applied.nodes.length).toBeGreaterThan(0);
  } finally {
    db.close();
  }
});

test("hybrid expand uses host runId from RetrievalIntent", async () => {
  const { db } = await indexed({
    files: [{ path: "src/math.ts", text: "export function add(a: number, b: number) { return a + b; }\n" }],
  });
  try {
    const missing = createRetrievalChannels({ snapshotId: SNAPSHOT_ID, db, nowIso: () => TS }).find(
      (channel) => channel.id === "hybrid",
    );
    if (missing === undefined) {
      throw new Error("missing hybrid channel");
    }
    await expect(
      collectDeltas(
        missing.expand(
          createRetrievalAction({
            id: "hy-1",
            channelId: "hybrid",
            targetClaimIds: [claimId("hy")],
            query: "add",
          }),
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow(/runId/);
    const hybrid = createRetrievalChannels({
      snapshotId: SNAPSHOT_ID,
      db,
      nowIso: () => TS,
      runId: RUN_ID,
    }).find((channel) => channel.id === "hybrid");
    if (hybrid === undefined) {
      throw new Error("missing hybrid channel");
    }
    const deltas = await collectDeltas(
      hybrid.expand(
        createRetrievalAction({
          id: "hy-2",
          channelId: "hybrid",
          targetClaimIds: [claimId("hy")],
          query: "add",
        }),
        new AbortController().signal,
      ),
    );
    expect(deltas.length).toBeGreaterThan(0);
  } finally {
    db.close();
  }
});
